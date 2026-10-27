#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { nativeToken } from "./portable-deployment.mjs";
import {
  normalizeTailscaleDnsName,
  tailscaleOrigins,
  tailscaleServePortState,
  validatePort,
} from "./deployment-helpers.mjs";

const execFileAsync = promisify(execFile);
const label = "com.daenonjanis.even-t3-bridge";
const guiDomain = `gui/${process.getuid()}`;
const appSupport = path.join(homedir(), "Library", "Application Support", "Even T3 Bridge");
const credentials = path.join(appSupport, "credentials");
const statePath = path.join(appSupport, "deployment-state.json");
const plistPath = path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeRequire = createRequire(path.join(repoRoot, "bridge", "package.json"));
const { default: WebSocket } = await import(pathToFileURL(bridgeRequire.resolve("ws")).href);

function fail(message) {
  throw new Error(message);
}

function note(message) {
  process.stdout.write(`${message}\n`);
}

async function privateFile(file, name) {
  const metadata = await lstat(file).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    fail(`${name} must be a regular user-owned file with mode 0600`);
  }
  return readFile(file, "utf8");
}

async function executable(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next fixed PATH entry.
    }
  }
  fail(`${name} is missing from PATH`);
}

async function expectStatus(url, status, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  if (response.status !== status) fail(`${url.pathname} returned ${response.status}, expected ${status}`);
}

function rpc(socket, id, method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", listener);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    const listener = (raw) => {
      let value;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (value?.type !== "response" || value.id !== id) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
}

async function openSocket(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ["even-t3-v1", `auth.${token}`]);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Private WSS connection timed out"));
    }, 15_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  if (process.platform !== "darwin") fail("Deployment verification supports macOS only");

  const [token, passphrase, stateRaw, plist] = await Promise.all([
    privateFile(path.join(credentials, "bridge-token"), "Bridge token"),
    privateFile(path.join(credentials, "pairing-passphrase"), "Pairing passphrase"),
    privateFile(statePath, "Deployment state"),
    privateFile(plistPath, "LaunchAgent plist"),
  ]);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail("Stored bridge token is invalid");
  if (passphrase.length < 12 || passphrase.length > 256 || /[\r\n\0]/.test(passphrase)) {
    fail("Stored pairing passphrase is invalid");
  }
  for (const forbidden of [token, passphrase, "BRIDGE_TOKEN", "BRIDGE_PASSPHRASE", "T3_ACCESS_TOKEN"]) {
    if (plist.includes(forbidden)) fail("LaunchAgent plist contains credential data");
  }
  if (
    !plist.includes("<string>/usr/bin/env</string>") ||
    !plist.includes("<string>-i</string>") ||
    plist.includes("<key>EnvironmentVariables</key>")
  ) {
    fail("LaunchAgent does not clear the inherited GUI environment");
  }
  note("Credential and LaunchAgent permissions: ok");

  let state;
  try {
    state = JSON.parse(stateRaw);
  } catch {
    fail("Deployment state is invalid JSON");
  }
  const host = normalizeTailscaleDnsName(state.host);
  const httpsPort = validatePort(state.httpsPort, "HTTPS port");
  const bridgePort = validatePort(state.bridgePort, "bridge port");
  const origins = tailscaleOrigins(host, httpsPort);

  await execFileAsync("/bin/launchctl", ["print", `${guiDomain}/${label}`], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  }).catch(() => fail("LaunchAgent is not loaded"));
  const node = process.execPath;
  const ownership = await execFileAsync(node, [
    path.join(repoRoot, "scripts", "port-preflight.mjs"),
    label,
    guiDomain,
    String(bridgePort),
  ], { encoding: "utf8", timeout: 5000 });
  if (ownership.stdout.trim() !== "owned") fail("Bridge listener is not owned by the LaunchAgent");
  note("LaunchAgent and loopback ownership: ok");

  const tailscale = await executable("tailscale");
  const serve = await execFileAsync(tailscale, ["serve", "status", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (tailscaleServePortState(JSON.parse(serve.stdout), host, httpsPort, bridgePort) !== "ours") {
    fail("Tailscale Serve does not match this deployment");
  }
  note("Private Tailscale Serve mapping: ok");

  const loopback = new URL(`http://127.0.0.1:${bridgePort}`);
  const privateHttps = new URL(origins.httpsOrigin);
  await expectStatus(new URL("/health", loopback), 200);
  await expectStatus(new URL("/health", privateHttps), 200);
  for (const origin of ["https://attacker.invalid", "null", "http://127.0.0.1:43751"]) {
    await expectStatus(new URL("/v1/status", privateHttps), 403, { headers: { Origin: origin } });
    await expectStatus(new URL("/v1/faceclaw/pair", privateHttps), 403, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }),
    });
  }
  await expectStatus(new URL("/v1/status", privateHttps), 401);
  note("Health, browser-origin denial, and missing-auth denial: ok");

  const pairing = await fetch(new URL("/v1/faceclaw/pair", privateHttps), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const pairingRaw = await pairing.text();
  let pairingValue;
  try {
    pairingValue = JSON.parse(pairingRaw);
  } catch {
    fail("Pairing returned invalid JSON");
  }
  const native = nativeToken(token);
  if (pairing.status !== 200 || pairingValue?.token !== native) fail("Pairing did not return the installed native token");
  await expectStatus(new URL("/v1/status", privateHttps), 401, { headers: { Authorization: `Bearer ${native}` } });
  await expectStatus(new URL("/v1/status", privateHttps), 200, { headers: { Authorization: `Bearer ${token}` } });
  note("Native pairing, owner/native credential separation, and authenticated HTTPS: ok");

  const socket = await openSocket(origins.eventsUrl, native);
  try {
    const sessions = await rpc(socket, "verify-sessions", "sessions.list");
    if (sessions?.error || !sessions?.result || !Array.isArray(sessions.result.unsettled)) {
      fail("Authenticated session read failed");
    }
    const voiceStart = await rpc(socket, "verify-voice-start", "voice.start");
    if (voiceStart?.error || voiceStart?.result?.format !== "pcm_s16le") {
      fail("Voice capture did not start");
    }
    socket.send(Buffer.alloc(32_000));
    const voiceFinish = await rpc(socket, "verify-voice-finish", "voice.finish", {}, 90_000);
    const acceptedSilence =
      typeof voiceFinish?.result?.text === "string" || voiceFinish?.error?.code === "no_speech";
    if (!acceptedSilence) fail("Local Whisper inference failed");
  } finally {
    socket.close();
  }
  note("Authenticated WSS, T3 read, and local Whisper inference: ok");

  const logBytes = await Promise.all([
    readFile(path.join(homedir(), "Library", "Logs", "Even T3 Bridge", "bridge.log")).catch(() => Buffer.alloc(0)),
    readFile(path.join(homedir(), "Library", "Logs", "Even T3 Bridge", "bridge.error.log")).catch(() => Buffer.alloc(0)),
  ]).then((values) => Buffer.concat(values));
  for (const secret of [Buffer.from(token), Buffer.from(passphrase), Buffer.from(native)]) {
    if (logBytes.includes(secret)) fail("Service logs contain a stored credential");
  }
  note("Log credential scan: ok");
  note(`Deployment verified: ${origins.eventsUrl}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Deployment verification failed"}\n`);
  process.exitCode = 1;
});
