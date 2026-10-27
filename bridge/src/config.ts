import { isAbsolute, normalize } from "node:path";
import { assertArchivePlatform } from "./archive-platform.js";
import { assertPosixFeature } from "./platform-support.js";
import type { BridgeConfig, RuntimeMode } from "./types.js";

const BASE64URL_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const RUNTIME_MODES = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
const LANGUAGE = /^(?:auto|[A-Za-z]{2,3})$/;
const MAX_PASSPHRASE_CHARS = 256;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function parseT3BaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("T3_BASE_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("T3_BASE_URL cannot contain credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("T3_BASE_URL must be an origin without a path");
  }
  return url;
}

function parseWhisperServerUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:") {
    throw new Error("WHISPER_SERVER_URL must use http");
  }
  if (!["127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("WHISPER_SERVER_URL must use a numeric loopback address");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("WHISPER_SERVER_URL cannot contain credentials, a query, or a fragment");
  }
  if (!url.pathname.endsWith("/inference")) {
    throw new Error("WHISPER_SERVER_URL must point to the whisper.cpp /inference endpoint");
  }
  return url;
}

function parseProjectIds(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw?.trim()) return null;
  const ids = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  if (ids.size === 0) return null;
  return ids;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const faceclawProjectId = env.BRIDGE_FACECLAW_PROJECT_ID?.trim() || undefined;
  if (faceclawProjectId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(faceclawProjectId)) throw new Error('Invalid BRIDGE_FACECLAW_PROJECT_ID');
  const refinementCodexPath = env.BRIDGE_REFINEMENT_CODEX_PATH?.trim() || undefined;
  if (refinementCodexPath && !isAbsolute(refinementCodexPath)) throw new Error('BRIDGE_REFINEMENT_CODEX_PATH must be absolute');
  if (refinementCodexPath) assertPosixFeature('Luna refinement', 'BRIDGE_REFINEMENT_CODEX_PATH');
  const host = env.BRIDGE_HOST?.trim() || "127.0.0.1";
  const bridgeToken = required(env, "BRIDGE_TOKEN");
  if (!BASE64URL_SECRET.test(bridgeToken)) {
    throw new Error("BRIDGE_TOKEN must be 32 to 256 base64url characters");
  }
  const configuredPassphrase = env.BRIDGE_PASSPHRASE;
  if (
    configuredPassphrase !== undefined &&
    (configuredPassphrase.length === 0 ||
      configuredPassphrase.length > MAX_PASSPHRASE_CHARS ||
      /[\r\n\u0000]/.test(configuredPassphrase))
  ) {
    throw new Error("BRIDGE_PASSPHRASE must be 1 to 256 characters without line breaks");
  }
  // Phones reach the bridge through Tailscale Serve; the listener stays local.
  if (!isLoopback(host)) throw new Error("BRIDGE_HOST must be a loopback address");
  const runtimeMode = (env.BRIDGE_RUNTIME_MODE?.trim() || "approval-required") as RuntimeMode;
  if (!RUNTIME_MODES.has(runtimeMode)) {
    throw new Error("BRIDGE_RUNTIME_MODE is not supported");
  }
  const whisperLanguage = env.WHISPER_LANGUAGE?.trim().toLowerCase() || "en";
  if (!LANGUAGE.test(whisperLanguage)) {
    throw new Error("WHISPER_LANGUAGE must be auto or a two-to-three-letter language code");
  }

  const archiveProject = env.BRIDGE_ARCHIVE_PROJECT_ID?.trim();
  const archiveRoot = env.BRIDGE_ARCHIVE_WORKSPACE_ROOT?.trim();
  if (archiveProject || archiveRoot) assertArchivePlatform();
  if (archiveRoot && (!isAbsolute(archiveRoot) || normalize(archiveRoot) !== archiveRoot || /[\u0000\r\n]/.test(archiveRoot))) {
    throw new Error("BRIDGE_ARCHIVE_WORKSPACE_ROOT must be a normalized absolute directory");
  }
  if (archiveProject && !/^[A-Za-z0-9_-]{1,128}$/.test(archiveProject)) {
    throw new Error("BRIDGE_ARCHIVE_PROJECT_ID is invalid");
  }
  const peerDirectory = env.BRIDGE_PEER_DIRECTORY?.trim();
  if (peerDirectory && (!isAbsolute(peerDirectory) || !isLoopback(host))) throw new Error("Peer federation requires an absolute private directory and loopback listener");
  if (peerDirectory) assertPosixFeature("Peer federation", "BRIDGE_PEER_DIRECTORY");
  const projectIds = parseProjectIds(env.BRIDGE_PROJECT_IDS);
  const signalCliPath = env.BRIDGE_SIGNAL_CLI_PATH;
  const signalDataDirectory = env.BRIDGE_SIGNAL_DATA_DIR;
  if (!!signalCliPath !== !!signalDataDirectory || [signalCliPath, signalDataDirectory].some(value =>
    value !== undefined && (!isAbsolute(value) || normalize(value) !== value || /[\u0000\r\n]/.test(value)))) {
    throw new Error('Signal requires normalized absolute BRIDGE_SIGNAL_CLI_PATH and BRIDGE_SIGNAL_DATA_DIR');
  }
  if (signalCliPath) assertPosixFeature('The Signal service', 'BRIDGE_SIGNAL_CLI_PATH and BRIDGE_SIGNAL_DATA_DIR');
  if (archiveProject && archiveRoot && projectIds && !projectIds.has(archiveProject)) {
    throw new Error("Archive project must be in BRIDGE_PROJECT_IDS");
  }
  return {
    ...(signalCliPath && signalDataDirectory ? { signal: { cliPath: signalCliPath, dataDirectory: signalDataDirectory } } : {}),
    ...(faceclawProjectId ? { faceclawProjectId } : {}),
    ...(refinementCodexPath ? { refinementCodexPath } : {}),
    ...(peerDirectory ? { peerDirectory } : {}),
    archive: archiveProject && archiveRoot ? { projectId: archiveProject, workspaceRoot: archiveRoot } : null,
    host,
    port: integer(env, "BRIDGE_PORT", 8787, 1, 65535),
    bridgeToken,
    bridgePassphrase: configuredPassphrase ?? null,
    projectIds: parseProjectIds(env.BRIDGE_PROJECT_IDS),
    runtimeMode,
    pollIntervalMs: integer(env, "BRIDGE_POLL_INTERVAL_MS", 500, 500, 60_000),
    rateLimitPerMinute: integer(env, "BRIDGE_RATE_LIMIT_PER_MINUTE", 120, 10, 10_000),
    maxBodyBytes: integer(env, "BRIDGE_MAX_BODY_BYTES", 16_384, 1024, 1_048_576),
    maxTextChars: integer(env, "BRIDGE_MAX_TEXT_CHARS", 8000, 1, 120_000),
    maxUpstreamBytes: integer(
      env,
      "BRIDGE_MAX_UPSTREAM_BYTES",
      8 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
    ),
    upstreamTimeoutMs: integer(env, "BRIDGE_UPSTREAM_TIMEOUT_MS", 10_000, 1000, 60_000),
    t3BaseUrl: parseT3BaseUrl(env.T3_BASE_URL?.trim() || "http://127.0.0.1:3773"),
    t3AccessToken: env.T3_ACCESS_TOKEN?.trim() || null,
    whisperServerUrl: parseWhisperServerUrl(
      env.WHISPER_SERVER_URL?.trim() || "http://127.0.0.1:8178/inference",
    ),
    whisperLanguage,
    whisperPartialIntervalMs: integer(
      env,
      "WHISPER_PARTIAL_INTERVAL_MS",
      2000,
      1000,
      10_000,
    ),
    transcriptionTimeoutMs: integer(
      env,
      "WHISPER_TRANSCRIPTION_TIMEOUT_MS",
      60_000,
      5000,
      180_000,
    ),
    maxVoiceBytes: integer(
      env,
      "BRIDGE_MAX_VOICE_BYTES",
      9_600_000,
      32_000,
      24_000_000,
    ),
  };
}
