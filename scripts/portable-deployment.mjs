import path from 'node:path';
import { createHmac } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { archiveEnvironment, tailscaleOrigins, validatePort, loopbackT3Url } from './deployment-helpers.mjs';
export { loopbackT3Url } from './deployment-helpers.mjs';

export const SERVICE_NAME = 'even-t3-bridge';
export function dataDirectory(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Even T3 Bridge');
  if (platform === 'win32') {
    const root = env.LOCALAPPDATA;
    if (!root || !path.win32.isAbsolute(root)) throw new Error('LOCALAPPDATA must be an absolute user directory');
    return path.win32.join(root, 'Even T3 Bridge');
  }
  if (platform === 'linux') {
    const root = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
    if (!path.posix.isAbsolute(root)) throw new Error('XDG_DATA_HOME must be absolute');
    return path.posix.join(root, 'even-t3-bridge');
  }
  throw new Error('Supported platforms: Windows, macOS, Linux');
}
export function cleanPath(value, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !paths.isAbsolute(value) || /[\x00-\x1f\x7f"\r\n]/.test(value)) throw new Error('Expected an absolute path without control characters or quotes');
  return value;
}
export function bridgeEnvironment(config) {
  return {
    ...(config.peerDirectory ? { BRIDGE_PEER_DIRECTORY: cleanPath(config.peerDirectory) } : {}),
    BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(validatePort(config.bridgePort)),
    BRIDGE_RUNTIME_MODE: 'approval-required', T3_BASE_URL: loopbackT3Url(config.t3BaseUrl),
    T3_BASE_DIR: cleanPath(config.t3BaseDir), T3_CLI_EXECUTABLE: cleanPath(config.t3Executable),
    ...(config.t3Entry ? { T3_CLI_ENTRY: cleanPath(config.t3Entry) } : {}),
    ...(config.refinementCodexPath ? { BRIDGE_REFINEMENT_CODEX_PATH: cleanPath(config.refinementCodexPath) } : {}),
    ...(config.whisperExecutable ? { WHISPER_CPP_SERVER_PATH: cleanPath(config.whisperExecutable) } : {}),
    WHISPER_MODEL_PATH: cleanPath(config.whisperModel),
    ...archiveEnvironment(config.archiveProjectId, config.archiveWorkspaceRoot),
  };
}
export function connectionInfo(config) {
  const urls = tailscaleOrigins(config.host, config.httpsPort);
  return { t3BridgeUrl: urls.eventsUrl };
}
function systemdQuote(value) {
  return '"' + cleanPath(value, 'linux').replaceAll('\\', '\\\\').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}
export function systemdUnit(node, runner, config) {
  return `[Unit]\nDescription=Faceclaw T3 Bridge\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${[node, runner, config].map(systemdQuote).join(' ')}\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
}
function ps(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
export function windowsTaskScript(node, runner, config) {
  [node, runner, config].forEach((value) => cleanPath(value, 'win32'));
  // Values become PowerShell literals, never executable text. Task action bypasses cmd.exe.
  const args = `"${runner}" "${config}"`;
  return `$ErrorActionPreference = 'Stop'\n$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n$name = 'Even T3 Bridge'\nif (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Existing task found; inspect it before reinstalling.' }\n$action = New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(args)}\n$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity\n$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited\n$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew\nRegister-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null\nStart-ScheduledTask -TaskName $name\n`;
}

// Must match faceclawToken() in bridge/src/faceclaw.ts.
export function nativeToken(bridgeToken) {
  return createHmac('sha256', bridgeToken).update('faceclaw-native-v1').digest('base64url');
}

export async function verifyLocalPairing(port, credentials, request = fetch) {
  const origin = `http://127.0.0.1:${validatePort(port)}`;
  const response = await request(`${origin}/v1/faceclaw/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: credentials.pairingPassphrase }),
    redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Local pairing verification failed; Tailscale was not changed'); }
  const result = await response.json();
  if (result?.token !== nativeToken(credentials.bridgeToken)) throw new Error('Local pairing returned an unexpected token; Tailscale was not changed');
  const denied = await request(`${origin}/v1/status`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  await denied.body?.cancel();
  if (denied.status !== 401) throw new Error('Local service did not require authentication; Tailscale was not changed');
}

export async function resolveT3Entry(entry) {
  cleanPath(entry);
  // Native Node cannot traverse Electron ASARs. Validate the archive file and
  // fixed T3 server entry; Electron resolves that entry when the CLI runs.
  const match = /^(.*[\\/]app\.asar)[\\/](.*)$/.exec(entry);
  if (match) {
    if (match[2].replaceAll('\\', '/') !== 'apps/server/dist/bin.mjs') throw new Error('Unexpected T3 ASAR server entry');
    const archive = await realpath(match[1]);
    await access(archive);
    return path.join(archive, 'apps', 'server', 'dist', 'bin.mjs');
  }
  await access(entry);
  return realpath(entry);
}
