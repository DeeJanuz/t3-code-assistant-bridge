import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  launchAgentPlist,
  launchctlStatusSummary,
  normalizeTailscaleDnsName,
  tailscaleInfoFromStatus,
  tailscaleOrigins,
  tailscaleServePortState,
  validatePort,
} from "./deployment-helpers.mjs";
import { classifyPortOwnership } from "./port-preflight.mjs";

const execFileAsync = promisify(execFile);

test("accepts a connected MagicDNS device and removes the status trailing dot", () => {
  assert.deepEqual(
    tailscaleInfoFromStatus({ BackendState: "Running", Self: { DNSName: "Mac.Example.ts.net.", Online: true } }),
    { dnsName: "mac.example.ts.net" },
  );
});

test("rejects disconnected status and attacker-controlled host syntax", () => {
  assert.throws(
    () => tailscaleInfoFromStatus({ BackendState: "Stopped", Self: { DNSName: "mac.x.ts.net.", Online: true } }),
    /not connected/,
  );
  assert.throws(
    () => tailscaleInfoFromStatus({ BackendState: "Running", Self: { DNSName: "mac.x.ts.net.", Online: false } }),
    /not connected/,
  );
  for (const value of ["evil.example.com", "*.ts.net", "mac.ts.net/path", "mac.ts.net\nInjected", "-x.ts.net"]) {
    assert.throws(() => normalizeTailscaleDnsName(value), /invalid MagicDNS/);
  }
  assert.throws(() => validatePort("8443x"), /integer/);
});

test("derives the native Faceclaw events URL from the Tailscale host", () => {
  assert.deepEqual(tailscaleOrigins("mac.example.ts.net", 8443), {
    httpsOrigin: "https://mac.example.ts.net:8443",
    wssOrigin: "wss://mac.example.ts.net:8443",
    eventsUrl: "wss://mac.example.ts.net:8443/v1/faceclaw/events",
  });
  assert.equal(tailscaleOrigins("mac.example.ts.net", 443).eventsUrl, "wss://mac.example.ts.net/v1/faceclaw/events");
});

test("classifies only the exact loopback Serve handler as owned", () => {
  const ours = {
    TCP: { "8443": { HTTPS: true } },
    Web: {
      "mac.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://localhost:8787" } } },
    },
  };
  assert.equal(tailscaleServePortState(ours, "mac.example.ts.net", 8443, 8787), "ours");
  assert.equal(tailscaleServePortState({}, "mac.example.ts.net", 8443, 8787), "empty");
  assert.equal(
    tailscaleServePortState({
      TCP: { "8443": { HTTPS: true } },
      Web: { "mac.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
    }, "mac.example.ts.net", 8443, 8787),
    "conflict",
  );
  assert.equal(
    tailscaleServePortState({
      TCP: { "8443": { HTTPS: true } },
      Web: { "mac.example.ts.net:8443": { Handlers: {
        "/": { Proxy: "http://127.0.0.1:8787" },
        "/other": { Proxy: "http://127.0.0.1:9000" },
      } } },
    }, "mac.example.ts.net", 8443, 8787),
    "conflict",
  );
});

test("launch agent keeps all long-lived credentials out of plist data", () => {
  const plist = launchAgentPlist({
    label: "com.example.bridge",
    runnerPath: "/tmp/T3 & Bridge/run-service.sh",
    workingDirectory: "/tmp/T3 & Bridge",
    nodeExecutable: "/opt/homebrew/bin/node",
    stdoutPath: "/tmp/T3 & Bridge/out.log",
    stderrPath: "/tmp/T3 & Bridge/error.log",
    host: "mac.example.ts.net",
    httpsPort: 8443,
    bridgePort: 8787,
  });
  assert.match(plist, /T3 &amp; Bridge/);
  assert.match(plist, /<string>\/usr\/bin\/env<\/string>[\s\S]*<string>-i<\/string>/);
  assert.match(plist, /BRIDGE_HOST=127\.0\.0\.1/);
  assert.match(plist, /127\.0\.0\.1/);
  assert.equal(plist.includes("ORIGIN"), false);
  assert.equal(plist.includes("<key>EnvironmentVariables</key>"), false);
  assert.equal(plist.includes("https://mac.example.ts.net:8443</string>"), false);
  for (const forbidden of ["BRIDGE_TOKEN", "BRIDGE_PASSPHRASE", "T3_ACCESS_TOKEN"]) {
    assert.equal(plist.includes(forbidden), false);
  }
});

test("launchctl status summary drops inherited environment and arbitrary job data", () => {
  const raw = `gui/501/com.example.bridge = {\n\tstate = running\n\tpid = 12345\n\truns = 7\n\tlast exit code = 0\n\tinherited environment = {\n\t\tUNRELATED_SECRET => should-never-print\n\t}\n\tprogram = /private/sensitive/path\n}`;
  const summary = launchctlStatusSummary(raw);
  assert.equal(summary, [
    "LaunchAgent state: running",
    "LaunchAgent pid: 12345",
    "LaunchAgent runs: 7",
    "LaunchAgent last exit code: 0",
    "",
  ].join("\n"));
  assert.equal(summary.includes("UNRELATED_SECRET"), false);
  assert.equal(summary.includes("should-never-print"), false);
  assert.equal(summary.includes("sensitive/path"), false);
});

test("service status never prints raw launchctl or full Tailscale Serve status", async () => {
  const script = await readFile(new URL("./service.sh", import.meta.url), "utf8");
  assert.match(script, /launchctl-status/);
  assert.match(script, /serve status --json/);
  assert.doesNotMatch(script, /launchctl print[^\n]*\|\s*\/usr\/bin\/sed/);
  assert.doesNotMatch(script, /serve status\s*\|\|/);
});

test("service control changes only the exact LaunchAgent and verifies port ownership", async () => {
  const script = await readFile(new URL("./service.sh", import.meta.url), "utf8");
  const startBranch = script.slice(script.indexOf("  start)"), script.indexOf("  stop)"));
  const stopBranch = script.slice(script.indexOf("  stop)"), script.indexOf("  restart)"));
  const restartBranch = script.slice(script.indexOf("  restart)"), script.indexOf("  status)"));
  for (const branch of [startBranch, restartBranch]) {
    assert.match(branch, /bridge_port_owner_state/);
    assert.match(branch, /port_state.*free.*owned/s);
    assert.match(branch, /launchctl (?:bootstrap|kickstart)/);
    assert.ok(branch.indexOf("launchctl enable") < branch.indexOf("launchctl bootstrap"));
    assert.match(branch, /bootstrap[\s\S]*launchctl disable/);
  }
  assert.match(stopBranch, /launchctl disable/);
  assert.match(stopBranch, /launchctl bootout/);
  assert.match(stopBranch, /bridge_port_owner_state/);
  assert.match(stopBranch, /port_state.*free.*agent_unloaded/s);
  assert.match(stopBranch, /! launchctl_loaded/);
  assert.doesNotMatch(stopBranch, /launchctl kill/);
  assert.doesNotMatch(script, /\bkill\s+-9\b|\bpkill\b|\bkillall\b/);
});

test("installer preflights the Serve port before credentials or filesystem writes", async () => {
  const script = await readFile(new URL("./install.sh", import.meta.url), "utf8");
  const earlyPortPreflight = script.indexOf("bridge_port_owner_state");
  const dependencyMutation = script.indexOf("ensure_homebrew\nNODE_PATH");
  const preflight = script.indexOf("serve status --json");
  const portPreflight = script.indexOf("port-preflight.mjs");
  assert.ok(preflight > 0);
  assert.ok(preflight < script.indexOf("secret_store passphrase"));
  assert.ok(preflight < script.indexOf("run_or_print /usr/bin/install -d"));
  assert.ok(portPreflight > preflight);
  assert.ok(portPreflight < script.indexOf("secret_store passphrase"));
  assert.ok(portPreflight < script.indexOf("run_or_print /usr/bin/install -d"));
  assert.ok(earlyPortPreflight > 0);
  assert.ok(earlyPortPreflight < dependencyMutation);
  const serviceMutation = script.indexOf('ROLLBACK_SERVICE_INSTALL=true');
  const bootout = script.indexOf('/bin/launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL"', serviceMutation);
  assert.ok(bootout > script.indexOf('run build'));
  assert.ok(bootout > script.indexOf('ci --omit=dev'));
  assert.ok(script.indexOf('deployment-helpers.mjs" launch-agent') > 0);
  assert.ok(bootout > script.indexOf('deployment-helpers.mjs" launch-agent'));
  assert.ok(bootout < script.indexOf('/bin/mv "$RUNTIME_STAGING" "$RUNTIME_DIR"'));
  const kickstart = script.indexOf('/bin/launchctl kickstart -k');
  const activationStart = script.indexOf('fs.writeFileSync');
  const enable = script.indexOf('/bin/launchctl enable', activationStart);
  const bootstrap = script.indexOf('/bin/launchctl bootstrap', activationStart);
  const healthCheck = script.indexOf('/health', kickstart);
  const serveMutation = script.indexOf('serve --bg');
  assert.ok(kickstart > bootout);
  assert.ok(enable > activationStart);
  assert.ok(enable < bootstrap);
  assert.ok(bootstrap < kickstart);
  assert.ok(healthCheck > kickstart);
  assert.ok(serveMutation > healthCheck);
  assert.ok(serveMutation > script.indexOf('Tailscale Serve was not changed'));
  assert.ok(serviceMutation < bootout);
  assert.ok(script.indexOf('ROLLBACK_SERVICE_INSTALL=false', serveMutation) > serveMutation);
  assert.match(script, /trap rollback_service_install EXIT/);
  assert.match(script, /rollback_service_install[\s\S]*launchctl disable[\s\S]*launchctl bootout[\s\S]*bridge_port_owner_state/);
  assert.match(script, /BRIDGE_PORT_STATE.*free.*PRIOR_AGENT_UNLOADED/s);
});

test("bridge port ownership follows the LaunchAgent process tree", () => {
  const parents = new Map([
    [500, 400],
    [400, 300],
    [900, 1],
  ]);
  assert.equal(classifyPortOwnership([], 300, parents), "free");
  assert.equal(classifyPortOwnership([500], 300, parents), "owned");
  assert.equal(classifyPortOwnership([500, 900], 300, parents), "occupied");
  assert.equal(classifyPortOwnership([500], null, parents), "occupied");
});

test("uninstaller preflights requested Serve removal before any deletion", async () => {
  const script = await readFile(new URL("./uninstall.sh", import.meta.url), "utf8");
  const preflight = script.indexOf("serve status --json");
  const firstBootout = script.indexOf("/bin/launchctl bootout");
  const firstRemoval = script.indexOf("/bin/rm -f");
  assert.ok(preflight > 0);
  assert.ok(preflight < firstBootout);
  assert.ok(preflight < firstRemoval);
  assert.match(script, /\/bin\/mv \"\$RUNTIME_DIR\" \"\$TRASH_HOLDER\/runtime\"/);
});

test("connection-info command derives the exact WSS events URL without reading credentials", async () => {
  const scriptUrl = new URL("./show-connection-info.sh", import.meta.url);
  const script = await readFile(scriptUrl, "utf8");
  const metadata = await stat(scriptUrl);
  if (process.platform !== "win32") assert.notEqual(metadata.mode & 0o100, 0);
  assert.match(script, /tailscale-host/);
  assert.match(script, /serve-port-state/);
  assert.match(script, /events-url/);
  assert.match(script, /STORED_HOST.*CURRENT_HOST/s);
  assert.match(script, /SERVE_STATE.*ours/s);
  assert.doesNotMatch(script, /secret_read|bridge-token|pairing-passphrase|BRIDGE_TOKEN|BRIDGE_PASSPHRASE/);
});

test("connection-info is exposed from the repository root and installer points back to it", async () => {
  const [packageJson, installer] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("./install.sh", import.meta.url), "utf8"),
  ]);
  assert.equal(packageJson.scripts["connection-info"], "./scripts/show-connection-info.sh");
  assert.match(installer, /repository root[^\n]*npm run connection-info/);
});

test("live verifier reads secrets only from private installed files and never prints response data", async () => {
  const url = new URL("./verify-deployment.mjs", import.meta.url);
  const script = await readFile(url, "utf8");
  assert.match(script, /privateFile\(path\.join\(credentials, "bridge-token"\)/);
  assert.match(script, /privateFile\(path\.join\(credentials, "pairing-passphrase"\)/);
  assert.doesNotMatch(script, /process\.argv.*(?:token|passphrase)/i);
  assert.doesNotMatch(script, /note\([^\n]*(?:token|passphrase|sessions|text)\)/i);
});

test("archive launch environment is explicitly paired and never changes authorization controls", () => {
  const base = { label: "com.example.bridge", runnerPath: "/tmp/run-service.sh", workingDirectory: "/tmp/bridge", nodeExecutable: "/opt/homebrew/bin/node", stdoutPath: "/tmp/out.log", stderrPath: "/tmp/error.log", host: "mac.example.ts.net", httpsPort: 8443, bridgePort: 8787 };
  assert.doesNotMatch(launchAgentPlist(base), /BRIDGE_ARCHIVE/);
  const configured = launchAgentPlist({ ...base, archiveProjectId: "assistant-project", archiveWorkspaceRoot: "/Users/test/Digital Assistant" });
  assert.match(configured, /BRIDGE_ARCHIVE_PROJECT_ID=assistant-project/);
  assert.match(configured, /BRIDGE_ARCHIVE_WORKSPACE_ROOT=\/Users\/test\/Digital Assistant/);
  assert.doesNotMatch(configured, /BRIDGE_TOKEN|T3_ACCESS_TOKEN|BRIDGE_RUNTIME_MODE/);
  for (const invalid of [{ archiveProjectId: "id" }, { archiveWorkspaceRoot: "/tmp/assistant" }, { archiveProjectId: "bad\nid", archiveWorkspaceRoot: "/tmp/assistant" }, { archiveProjectId: "id", archiveWorkspaceRoot: "relative" }, { archiveProjectId: "id", archiveWorkspaceRoot: "/tmp/../etc" }]) assert.throws(() => launchAgentPlist({ ...base, ...invalid }), /Archive setup/);
});
