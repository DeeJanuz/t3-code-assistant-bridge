import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validatePort(raw, name = "port") {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

export function normalizeTailscaleDnsName(raw) {
  if (typeof raw !== "string") throw new Error("Tailscale did not report a DNS name");
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!DNS_NAME.test(value) || !value.endsWith(".ts.net")) {
    throw new Error("Tailscale reported an invalid MagicDNS name");
  }
  return value;
}

export function tailscaleInfoFromStatus(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tailscale returned invalid status data");
  }
  if (value.BackendState !== "Running" || value.Self?.Online !== true) {
    throw new Error("Tailscale is not connected. Sign in and connect this Mac first");
  }
  const self = value.Self;
  if (typeof self !== "object" || self === null || Array.isArray(self)) {
    throw new Error("Tailscale status is missing this device");
  }
  return { dnsName: normalizeTailscaleDnsName(self.DNSName) };
}

export function tailscaleOrigins(host, httpsPort) {
  const dnsName = normalizeTailscaleDnsName(host);
  const port = validatePort(httpsPort, "HTTPS port");
  const authority = port === 443 ? dnsName : `${dnsName}:${port}`;
  return {
    httpsOrigin: `https://${authority}`,
    wssOrigin: `wss://${authority}`,
    eventsUrl: `wss://${authority}/v1/faceclaw/events`,
  };
}

export function tailscaleServePortState(status, host, httpsPort, bridgePort) {
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    throw new Error("Tailscale returned invalid Serve status data");
  }
  const dnsName = normalizeTailscaleDnsName(host);
  const https = validatePort(httpsPort, "HTTPS port");
  const bridge = validatePort(bridgePort, "bridge port");
  const authority = `${dnsName}:${https}`;
  const tcp = status.TCP;
  const web = status.Web;
  const tcpEntry = typeof tcp === "object" && tcp !== null ? tcp[String(https)] : undefined;
  const webEntry = typeof web === "object" && web !== null ? web[authority] : undefined;
  if (tcpEntry === undefined && webEntry === undefined) return "empty";
  const handlers = typeof webEntry === "object" && webEntry !== null ? webEntry.Handlers : undefined;
  const root = typeof handlers === "object" && handlers !== null ? handlers["/"] : undefined;
  const proxy = typeof root === "object" && root !== null ? root.Proxy : undefined;
  if (tcpEntry?.HTTPS !== true || typeof proxy !== "string") return "conflict";
  let target;
  try {
    target = new URL(proxy);
  } catch {
    return "conflict";
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(target.hostname);
  const targetPort = Number(target.port || (target.protocol === "http:" ? 80 : 443));
  const onlyRootHandler = Object.keys(handlers).length === 1;
  if (
    target.protocol === "http:" &&
    loopback &&
    targetPort === bridge &&
    target.pathname === "/" &&
    target.search === "" &&
    target.hash === "" &&
    onlyRootHandler
  ) {
    return "ours";
  }
  return "conflict";
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistValue(value, indent) {
  const padding = "  ".repeat(indent);
  if (typeof value === "string") return `${padding}<string>${xml(value)}</string>`;
  if (typeof value === "number") return `${padding}<integer>${value}</integer>`;
  if (typeof value === "boolean") return `${padding}<${value ? "true" : "false"}/>`;
  if (Array.isArray(value)) {
    return `${padding}<array>\n${value.map((entry) => plistValue(entry, indent + 1)).join("\n")}\n${padding}</array>`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(
      ([key, entry]) => `${"  ".repeat(indent + 1)}<key>${xml(key)}</key>\n${plistValue(entry, indent + 1)}`,
    );
    return `${padding}<dict>\n${entries.join("\n")}\n${padding}</dict>`;
  }
  throw new Error("Unsupported launch agent value");
}

export function archiveEnvironment(projectId, workspaceRoot) {
  if (!projectId && !workspaceRoot) return {};
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId) ||
      typeof workspaceRoot !== "string" || !path.posix.isAbsolute(workspaceRoot) || path.posix.normalize(workspaceRoot) !== workspaceRoot || /[\u0000\r\n]/.test(workspaceRoot)) {
    throw new Error("Archive setup requires an exact project ID and normalized absolute workspace root");
  }
  return { BRIDGE_ARCHIVE_PROJECT_ID: projectId, BRIDGE_ARCHIVE_WORKSPACE_ROOT: workspaceRoot };
}

export function loopbackT3Url(raw = "http://127.0.0.1:3773") {
  if (typeof raw !== "string" || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error("Managed T3 authentication requires a numeric loopback HTTP origin");
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Managed T3 authentication requires a numeric loopback HTTP origin");
  }
  return url.origin;
}

export function macT3Environment(options = {}) {
  const environment = { T3_BASE_URL: loopbackT3Url(options.t3BaseUrl || undefined) };
  for (const [option, name] of [["t3AppPath", "T3_APP_PATH"], ["t3BaseDir", "T3_BASE_DIR"]]) {
    const value = options[option];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Custom T3 paths must be normalized absolute macOS paths without control characters");
    }
    if (option === "t3AppPath" && !value.endsWith(".app")) throw new Error("T3 app path must select an installed .app bundle");
    environment[name] = value;
  }
  return environment;
}

export function launchAgentPlist(options) {
  const bridgePort = validatePort(options.bridgePort, "bridge port");
  tailscaleOrigins(options.host, options.httpsPort);
  if (typeof options.label !== "string" || !/^[A-Za-z0-9.-]{1,128}$/.test(options.label)) {
    throw new Error("label is invalid");
  }
  for (const [name, value] of Object.entries({
    runnerPath: options.runnerPath,
    workingDirectory: options.workingDirectory,
    nodeExecutable: options.nodeExecutable,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new Error(`${name} is invalid`);
    }
    if (/[\u0000\r\n]/.test(value)) throw new Error(`${name} contains invalid data`);
  }
  const serviceEnvironment = {
    ...archiveEnvironment(options.archiveProjectId, options.archiveWorkspaceRoot),
    NODE_EXECUTABLE: options.nodeExecutable,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: String(bridgePort),
    ...macT3Environment(options),
  };
  const document = {
    Label: options.label,
    // launchd jobs otherwise inherit the GUI session environment, which may
    // contain credentials from unrelated applications. Clear it before zsh,
    // the bridge, T3's CLI, or Whisper starts.
    ProgramArguments: [
      "/usr/bin/env",
      "-i",
      ...Object.entries(serviceEnvironment).map(([key, value]) => `${key}=${value}`),
      "/bin/zsh",
      options.runnerPath,
    ],
    WorkingDirectory: options.workingDirectory,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30,
    ProcessType: "Background",
    Umask: 63,
    StandardOutPath: options.stdoutPath,
    StandardErrorPath: options.stderrPath,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(document, 0)}\n</plist>\n`;
}

export function launchctlStatusSummary(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024) {
    throw new Error("launchctl status data is invalid");
  }
  const fields = [];
  const patterns = [
    ["state", /^\s*state\s*=\s*([a-z][a-z-]{0,31})\s*$/m],
    ["pid", /^\s*pid\s*=\s*(\d{1,10})\s*$/m],
    ["runs", /^\s*runs\s*=\s*(\d{1,10})\s*$/m],
    ["last exit code", /^\s*last exit code\s*=\s*(-?\d{1,10})\s*$/m],
  ];
  for (const [label, pattern] of patterns) {
    const match = pattern.exec(raw);
    if (match) fields.push(`LaunchAgent ${label}: ${match[1]}`);
  }
  return fields.length > 0 ? `${fields.join("\n")}\n` : "LaunchAgent: loaded\n";
}

async function atomicWrite(filePath, contents, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode, flag: "wx" });
  await rename(temporary, filePath);
}

async function readStandardInput(maximumBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > maximumBytes) throw new Error("Input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "tailscale-info" || command === "tailscale-host") {
    const status = JSON.parse(await readStandardInput());
    const info = tailscaleInfoFromStatus(status);
    process.stdout.write(command === "tailscale-host" ? `${info.dnsName}\n` : `${JSON.stringify(info)}\n`);
    return;
  }
  if (command === "serve-port-state") {
    const [host, httpsPort, bridgePort] = args;
    if ([host, httpsPort, bridgePort].some((value) => typeof value !== "string")) {
      throw new Error("serve-port-state requires host, HTTPS port, and bridge port");
    }
    const status = JSON.parse(await readStandardInput());
    process.stdout.write(`${tailscaleServePortState(status, host, httpsPort, bridgePort)}\n`);
    return;
  }
  if (command === "launchctl-status") {
    process.stdout.write(launchctlStatusSummary(await readStandardInput()));
    return;
  }
  if (command === "t3-environment") {
    const [t3AppPath = "", t3BaseDir = "", t3BaseUrl = ""] = args;
    process.stdout.write(`${JSON.stringify(macT3Environment({ t3AppPath, t3BaseDir, t3BaseUrl }))}\n`);
    return;
  }
  if (command === "events-url") {
    const [host, httpsPort] = args;
    if (typeof host !== "string" || typeof httpsPort !== "string") {
      throw new Error("events-url requires a Tailscale host and HTTPS port");
    }
    process.stdout.write(`${tailscaleOrigins(host, httpsPort).eventsUrl}\n`);
    return;
  }
  if (command === "launch-agent") {
    const [
      outputPath,
      label,
      runnerPath,
      workingDirectory,
      nodeExecutable,
      stdoutPath,
      stderrPath,
      host,
      httpsPort,
      bridgePort,
      archiveProjectId = "",
      archiveWorkspaceRoot = "",
      t3AppPath = "",
      t3BaseDir = "",
      t3BaseUrl = "",
    ] = args;
    if ([outputPath, label, runnerPath, workingDirectory, nodeExecutable, stdoutPath, stderrPath, host, httpsPort, bridgePort]
      .some((value) => typeof value !== "string")) {
      throw new Error("launch-agent requires all deployment values");
    }
    await atomicWrite(outputPath, launchAgentPlist({
      label,
      runnerPath,
      workingDirectory,
      nodeExecutable,
      stdoutPath,
      stderrPath,
      host,
      httpsPort,
      bridgePort,
      archiveProjectId,
      archiveWorkspaceRoot,
      t3AppPath,
      t3BaseDir,
      t3BaseUrl,
    }));
    return;
  }
  throw new Error("Unknown deployment helper command");
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Deployment helper failed"}\n`);
    process.exitCode = 1;
  });
}
