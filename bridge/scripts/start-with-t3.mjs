import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dataDirectory, loopbackT3Url, cleanPath, resolveT3Entry } from "../../scripts/portable-deployment.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_APP_PATHS = ["T3 Code", "T3 Code (Alpha)", "T3 Code (Nightly)"].flatMap((name) => [
  `/Applications/${name}.app`,
  path.join(homedir(), "Applications", `${name}.app`),
]);
const label = `even-t3-bridge-${randomUUID()}`;
const DEFAULT_MODEL_PATH = path.join(
  dataDirectory(),
  "models",
  "ggml-base.en.bin",
);

function safeFailure(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function environmentWithoutBridgeSecrets(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.BRIDGE_TOKEN;
  delete env.BRIDGE_PASSPHRASE;
  delete env.T3_ACCESS_TOKEN;
  return env;
}

/**
 * The CLI of the runtime T3's boot service runs. T3 self-updates into
 * `runtime/versions/<version>`, so pinned CLI paths go stale, and an older
 * CLI issues pairing credentials the newer server rejects.
 */
export async function activeRuntimeCli(baseDir, serverVersion = null) {
  try {
    const state = JSON.parse(await readFile(path.join(baseDir, "runtime", "service-state.json"), "utf8"));
    const version = state?.activeVersion;
    if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)) return null;
    // A desktop app can serve while an older CLI runtime's state remains.
    if (serverVersion !== null && version !== serverVersion) return null;
    const executable = path.join(baseDir, "runtime", "versions", version, process.platform === "win32" ? "t3.exe" : "t3");
    await access(executable, constants.X_OK);
    return { executable: await realpath(executable), entry: null };
  } catch {
    return null;
  }
}

/** The running server's version, used to pick the matching app bundle. Best effort. */
export async function runningServerVersion(baseUrl) {
  try {
    const response = await fetch(new URL("/.well-known/t3/environment", baseUrl), {
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    if (!response.ok || raw.length > 65_536) return null;
    const version = JSON.parse(raw)?.serverVersion;
    return typeof version === "string" && version.length <= 64 ? version : null;
  } catch {
    return null;
  }
}

async function plistValue(plist, key) {
  const metadata = await execFileAsync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], {
    env: environmentWithoutBridgeSecrets(), encoding: "utf8", timeout: 5000, maxBuffer: 4096,
  });
  return metadata.stdout.trim();
}

export async function findApp({ baseDir, serverVersion = null } = {}) {
  const active = baseDir ? await activeRuntimeCli(baseDir, serverVersion) : null;
  if (active) return active;
  if (process.env.T3_CLI_EXECUTABLE || process.env.T3_CLI_ENTRY) {
    const executable = cleanPath(process.env.T3_CLI_EXECUTABLE);
    await access(executable, constants.X_OK);
    // The native t3 CLI is a single executable with no separate server entry.
    const entry = process.env.T3_CLI_ENTRY ? await resolveT3Entry(cleanPath(process.env.T3_CLI_ENTRY)) : null;
    return { executable: await realpath(executable), entry };
  }
  if (process.platform !== "darwin") throw new Error("Set T3_CLI_EXECUTABLE to your installed T3 Code executable, plus T3_CLI_ENTRY for an Electron or Node server bin.mjs.");
  const candidates = process.env.T3_APP_PATH
    ? [path.resolve(process.env.T3_APP_PATH)]
    : DEFAULT_APP_PATHS;
  const found = [];
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const plist = path.join(resolved, "Contents", "Info.plist");
      const executableName = await plistValue(plist, "CFBundleExecutable");
      if (!executableName || executableName === "." || executableName === ".." || /[\\/\u0000-\u001f\u007f]/.test(executableName)) continue;
      const executable = path.join(resolved, "Contents", "MacOS", executableName);
      const archive = path.join(resolved, "Contents", "Resources", "app.asar");
      const entry = path.join(archive, "apps", "server", "dist", "bin.mjs");
      await Promise.all([access(executable, constants.X_OK), access(archive)]);
      const version = await plistValue(plist, "CFBundleShortVersionString").catch(() => null);
      found.push({ executable, entry, version });
    } catch {
      // Try the next fixed installation location.
    }
  }
  // Several channels can be installed; only the running server's CLI mints valid credentials.
  const chosen = found.find((app) => serverVersion !== null && app.version === serverVersion) ?? found[0];
  if (chosen) return { executable: chosen.executable, entry: chosen.entry };
  throw new Error("T3 Code was not found. Set T3_APP_PATH to the installed .app bundle.");
}

async function executableOnPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the fixed PATH entries.
    }
  }
  return null;
}

function whisperPort() {
  const raw = process.env.WHISPER_SERVER_PORT || "8178";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("WHISPER_SERVER_PORT must be an integer from 1 through 65535.");
  }
  return value;
}

async function startManagedWhisper() {
  if (process.env.WHISPER_SERVER_URL) {
    return { child: null, url: process.env.WHISPER_SERVER_URL };
  }
  const configuredExecutable = process.env.WHISPER_CPP_SERVER_PATH;
  const executable = configuredExecutable
    ? await realpath(path.resolve(configuredExecutable)).catch(() => null)
    : await executableOnPath("whisper-server");
  if (!executable) {
    throw new Error("whisper-server was not found. Run npm run setup:whisper first.");
  }
  await access(executable, constants.X_OK);
  const model = await realpath(path.resolve(process.env.WHISPER_MODEL_PATH || DEFAULT_MODEL_PATH)).catch(
    () => null,
  );
  if (!model) throw new Error("The Whisper model was not found. Run npm run setup:whisper first.");
  await access(model);

  const port = whisperPort();
  const requestPath = `/even-t3-${randomBytes(16).toString("hex")}`;
  const inferenceUrl = `http://127.0.0.1:${port}${requestPath}/inference`;
  const readyUrl = `http://127.0.0.1:${port}${requestPath}/`;
  const child = spawn(
    executable,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--request-path",
      requestPath,
      "--model",
      model,
    ],
    {
      env: environmentWithoutBridgeSecrets(),
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error("whisper-server exited during startup.");
    try {
      const response = await fetch(readyUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) return { child, url: inferenceUrl };
    } catch {
      // The model may still be loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error("whisper-server did not become ready within 30 seconds.");
}

async function stopManagedWhisper(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export async function runT3(cli, args) {
  try {
    return await execFileAsync(cli.executable, cli.entry ? [cli.entry, ...args] : args, {
      env: environmentWithoutBridgeSecrets({ ELECTRON_RUN_AS_NODE: "1" }),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
  } catch {
    throw new Error("The T3 Code authentication command failed.");
  }
}

function parseJson(raw, message) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(message);
  }
}

async function mintScopedToken(cli, baseDir, baseUrl) {
  const pairing = await runT3(cli, [
    "auth",
    "pairing",
    "create",
    "--base-dir",
    baseDir,
    "--ttl",
    "2m",
    "--label",
    label,
    "--json",
  ]);
  const issued = parseJson(pairing.stdout, "T3 Code returned invalid pairing JSON.");
  if (
    typeof issued !== "object" ||
    issued === null ||
    typeof issued.id !== "string" ||
    typeof issued.credential !== "string"
  ) {
    throw new Error("T3 Code returned incomplete pairing data.");
  }

  try {
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: issued.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: label,
      client_device_type: "bot",
      client_os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    });
    const response = await fetch(new URL("/oauth/token", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await response.text();
    if (!response.ok || Buffer.byteLength(raw) > 65_536) {
      throw new Error("T3 Code rejected the scoped token exchange.");
    }
    const token = parseJson(raw, "T3 Code returned invalid token JSON.");
    if (
      typeof token !== "object" ||
      token === null ||
      typeof token.access_token !== "string" ||
      token.token_type !== "Bearer"
    ) {
      throw new Error("T3 Code returned an unexpected scoped token.");
    }
    const scopes =
      typeof token.scope === "string" ? new Set(token.scope.split(/\s+/).filter(Boolean)) : null;
    if (
      scopes?.size !== 2 ||
      !scopes.has("orchestration:read") ||
      !scopes.has("orchestration:operate")
    ) {
      throw new Error("T3 Code returned an unexpected scoped token.");
    }
    const encodedClaims = token.access_token.split(".", 1)[0];
    const claims = parseJson(
      Buffer.from(encodedClaims, "base64url").toString("utf8"),
      "T3 Code returned an unrecognized access token.",
    );
    if (
      typeof claims !== "object" ||
      claims === null ||
      claims.kind !== "session" ||
      typeof claims.sid !== "string"
    ) {
      throw new Error("T3 Code returned an unrecognized access token.");
    }
    return { accessToken: token.access_token, sessionId: claims.sid };
  } catch (error) {
    await runT3(cli, ["auth", "pairing", "revoke", "--base-dir", baseDir, issued.id]).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function main() {
  if (process.env.T3_ACCESS_TOKEN) {
    throw new Error("Unset T3_ACCESS_TOKEN before using start:t3 so temporary access can be revoked.");
  }
  const { loadConfig } = await import("../dist/src/config.js");
  const { startBridgeRuntime } = await import("../dist/src/runtime.js");
  if (process.platform === 'darwin' && !process.env.BRIDGE_PEER_DIRECTORY) {
    const directory = path.join(dataDirectory(), 'peers');
    try {
      const { readPeerFile } = await import('../dist/src/peer-store.js');
      const settings = JSON.parse(await readPeerFile(path.join(directory, 'settings.json')));
      if (settings.enabled === true) process.env.BRIDGE_PEER_DIRECTORY = directory;
    } catch (error) {
      if (error.code !== 'ENOENT') process.stderr.write('Peer settings unavailable; starting local T3 only.\n');
    }
  }
  const config = loadConfig();
  const baseUrl = new URL(loopbackT3Url(config.t3BaseUrl.href));
  const requestedBaseDir = path.resolve(process.env.T3_BASE_DIR || path.join(homedir(), ".t3"));
  const baseDir = await realpath(requestedBaseDir).catch(() => requestedBaseDir);
  // Bind the phone/dashboard server before looking for either optional provider.
  // Secrets remain in this process and are never put in a child bridge environment.
  const runtime = startBridgeRuntime(config);
  let stopping = false;
  let t3Timer = null;
  let whisperTimer = null;
  let t3Work = Promise.resolve();
  let whisperWork = Promise.resolve();
  let session = null;
  let whisperChild = null;
  let t3Status = null;
  let whisperStatus = null;
  const status = (provider, available) => {
    const previous = provider === "T3" ? t3Status : whisperStatus;
    if (previous === available) return;
    if (provider === "T3") t3Status = available; else whisperStatus = available;
    process.stdout.write(`${provider} ${available ? "ready" : "unavailable; phone inbox remains available"}.\n`);
  };
  const revoke = async (owned) => {
    if (!owned) return;
    // T3 may have updated since minting; revoke with the current CLI.
    const cli = await findApp({ baseDir, serverVersion: await runningServerVersion(baseUrl) }).catch(() => owned.cli);
    await runT3(cli, ["auth", "session", "revoke", "--base-dir", baseDir, owned.sessionId]).catch(
      () => process.stderr.write("Warning: temporary T3 session revocation failed. Revoke it in T3 Code.\n"),
    );
  };
  async function refreshT3() {
    const localAttempt = (async () => {
      if (session === null) {
        const cli = await findApp({ baseDir, serverVersion: await runningServerVersion(baseUrl) });
        const minted = await mintScopedToken(cli, baseDir, baseUrl);
        session = { ...minted, cli };
      }
      if (stopping) return false;
      await runtime.useT3Token(session.accessToken);
      return true;
    })();
    const [local] = await Promise.allSettled([localAttempt]);
    if (local.status === "rejected") {
      runtime.clearT3();
      if (local.reason?.code === "upstream_auth_failed" && session !== null) {
        const expired = session; session = null;
        await revoke(expired);
      }
    }
    if (!stopping) {
      status("T3", local.status === "fulfilled" && local.value);
      t3Timer = setTimeout(() => { t3Work = refreshT3(); }, 10_000);
    }
  }
  function retryWhisper() {
    if (!stopping && whisperTimer === null) whisperTimer = setTimeout(() => {
      whisperTimer = null; whisperWork = refreshWhisper();
    }, 10_000);
  }
  async function refreshWhisper() {
    try {
      const whisper = await startManagedWhisper();
      if (stopping) { await stopManagedWhisper(whisper.child); return; }
      whisperChild = whisper.child;
      runtime.useWhisper(new URL(whisper.url));
      status("Whisper", true);
      if (whisper.child !== null) {
        const ended = () => {
          if (whisperChild !== whisper.child) return;
          whisperChild = null;
          runtime.useWhisper(null);
          if (!stopping) { status("Whisper", false); retryWhisper(); }
        };
        whisper.child.once("exit", ended);
        whisper.child.once("error", ended);
        if (whisper.child.exitCode !== null || whisper.child.signalCode !== null) ended();
      }
    } catch {
      runtime.useWhisper(null);
      if (!stopping) { status("Whisper", false); retryWhisper(); }
    }
  }
  const stopped = new Promise((resolve) => {
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(t3Timer); clearTimeout(whisperTimer);
      runtime.clearT3(); runtime.useWhisper(null);
      runtime.server.close();
      // In-flight mint owns a session too; wait before revocation, even on shutdown.
      await Promise.allSettled([t3Work, whisperWork]);
      runtime.clearT3();
      await Promise.allSettled([revoke(session), stopManagedWhisper(whisperChild)]);
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    runtime.server.once("error", () => { process.exitCode = 1; void stop(); });
  });
  t3Work = refreshT3();
  whisperWork = refreshWhisper();
  await stopped;
  process.exit(process.exitCode || 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    safeFailure(error instanceof Error ? error.message : "Bridge launch failed.");
  });
}
