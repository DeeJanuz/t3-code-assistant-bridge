#!/usr/bin/env node
// First-install helper. Existing installations are deliberately never overwritten.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { archiveEnvironment, tailscaleInfoFromStatus, tailscaleServePortState, validatePort } from './deployment-helpers.mjs';
import { cleanPath, connectionInfo, dataDirectory, loopbackT3Url, resolveT3Entry, systemdUnit, windowsTaskScript } from './portable-deployment.mjs';
const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function command(executable, args) {
  // A PowerShell 7 parent's PSModulePath stops Windows PowerShell 5.1 from loading built-in modules.
  const env = path.basename(executable).toLowerCase() === 'powershell.exe'
    ? Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')) : process.env;
  try { return await exec(executable, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env }); }
  catch { throw new Error(`A ${path.basename(executable)} command failed. Inspect prerequisites and permissions; no command output or credentials were logged.`); }
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function assertPrivateDirectory(directory) {
  cleanPath(directory);
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!await exists(current)) await mkdir(current, { mode: 0o700 });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Install directory cannot contain symbolic links');
  }
  const stat = await lstat(directory);
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Install directory must be owned by this user with mode 0700');
}
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already occupied. No process was stopped.`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}
export function parseArguments(argv) {
  const options = { httpsPort: 8443, bridgePort: 8787, t3BaseUrl: 'http://127.0.0.1:3773', t3BaseDir: path.join(homedir(), '.t3'), dryRun: false };
  const values = { '--https-port': 'httpsPort', '--bridge-port': 'bridgePort', '--t3-url': 't3BaseUrl', '--t3-base-dir': 't3BaseDir', '--t3-executable': 't3Executable', '--t3-entry': 't3Entry', '--refinement-codex-path': 'refinementCodexPath', '--whisper-executable': 'whisperExecutable', '--whisper-model': 'whisperModel', '--tailscale-executable': 'tailscaleExecutable', '--archive-project-id': 'archiveProjectId', '--archive-workspace-root': 'archiveWorkspaceRoot' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    const key = values[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown option or missing value');
    options[key] = argv[++i];
  }
  options.httpsPort = validatePort(options.httpsPort); options.bridgePort = validatePort(options.bridgePort);
  if (options.httpsPort === options.bridgePort) throw new Error('Bridge and HTTPS ports must differ');
  options.t3BaseUrl = loopbackT3Url(options.t3BaseUrl);
  for (const key of ['t3Executable', 't3Entry', 't3BaseDir', 'whisperExecutable', 'whisperModel', 'tailscaleExecutable', 'refinementCodexPath']) {
    if (['refinementCodexPath', 't3Entry'].includes(key) && !options[key]) continue;
    if (!options[key]) throw new Error(`Missing ${key}; the installation skill must discover the installed prerequisite first`);
    cleanPath(options[key]);
  }
  // Both or neither; the bridge rejects archive setup on Windows at startup.
  archiveEnvironment(options.archiveProjectId, options.archiveWorkspaceRoot);
  return options;
}
export const HELP = `Usage: node scripts/install-portable.mjs [--dry-run] OPTIONS

First install for Windows/Linux; use scripts/install.sh on macOS.
Required absolute paths:
  --t3-executable PATH       Existing T3 Electron, Node, or native t3 CLI executable
  --refinement-codex-path PATH
                              Codex CLI used for optional Luna refinement
  --whisper-executable PATH  Installed whisper-server executable
  --whisper-model PATH       Verified ggml-base.en.bin
  --tailscale-executable PATH Installed Tailscale executable
Optional:
  --t3-entry PATH            Existing T3 server bin.mjs (including app.asar path);
                              required unless --t3-executable is the native t3 CLI.
                              The CLI of T3's active runtime under the base directory
                              takes precedence whenever it exists.
  --t3-base-dir PATH         Existing T3 state directory (default: ~/.t3)
  --t3-url ORIGIN            Numeric loopback HTTP origin (default: http://127.0.0.1:3773)
  --https-port PORT          Private Tailscale HTTPS port (default: 8443)
  --bridge-port PORT         Local bridge port (default: 8787)
  --archive-project-id ID    T3 project whose conversations are archived (macOS/Linux)
  --archive-workspace-root PATH
                              That project's workspace; both archive flags are required together
  --dry-run                 Show plan without creating files or services
  --help, -h                Show this help without inspecting host state
`;
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { process.stdout.write(HELP); return; }
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('On macOS use scripts/install.sh; this helper supports Windows and Linux');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 16) throw new Error('Node 22.16 or newer is required');
  if (process.platform !== 'win32' && process.getuid() === 0) throw new Error('Run as the desktop user, not root');
  const options = parseArguments(argv);
  const directory = path.join(dataDirectory(), 'service');
  const configPath = path.join(directory, 'portable-config.json');
  const credentialsPath = path.join(directory, 'credentials.json');
  const runner = path.join(repo, 'scripts', 'portable-service.mjs');
  const unitPath = path.join(homedir(), '.config', 'systemd', 'user', 'even-t3-bridge.service');
  if (options.dryRun) {
    console.log(JSON.stringify({ platform: process.platform, configPath, credentialsPath, autostart: process.platform === 'linux' ? unitPath : 'Even T3 Bridge scheduled task at user login', actions: ['Validate compiled checkout, installed prerequisites, ports, and Tailscale ownership', 'Create private credentials and configuration without logging secrets', 'Enable private Tailscale Serve and startup at user login', 'Verify loopback health and output personal URLs'] }, null, 2));
    return;
  }
  for (const key of ['t3Executable', 't3BaseDir', 'whisperExecutable', 'whisperModel', 'tailscaleExecutable']) await access(options[key]);
  if (options.refinementCodexPath) await access(options.refinementCodexPath);
  if (options.archiveWorkspaceRoot) {
    const stat = await lstat(options.archiveWorkspaceRoot);
    if (!stat.isDirectory() || await realpath(options.archiveWorkspaceRoot) !== options.archiveWorkspaceRoot) throw new Error('Archive workspace must be an existing local directory without symlinks');
  }
  if (options.t3Entry) options.t3Entry = await resolveT3Entry(options.t3Entry);
  await access(path.join(repo, 'bridge', 'dist', 'src', 'runtime.js'));
  const compiled = await import(pathToFileURL(path.join(repo, 'bridge', 'dist', 'src', 'config.js')).href);
  // Validate secure defaults using the same parser as the running bridge.
  const { bridgeEnvironment } = await import('./portable-deployment.mjs');
  compiled.loadConfig({ ...bridgeEnvironment(options), BRIDGE_TOKEN: 'a'.repeat(43) });
  if (await exists(directory) || process.platform === 'linux' && await exists(unitPath)) throw new Error('Existing install detected. Inspect and manage it before reinstalling; nothing was overwritten');
  if (process.platform === 'linux') await command('systemctl', ['--user', 'show-environment']);
  else await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-ScheduledTask -TaskName 'Even T3 Bridge' -ErrorAction SilentlyContinue) { exit 1 }"]);
  const tailscale = await realpath(options.tailscaleExecutable);
  const status = await command(tailscale, ['status', '--json']);
  const host = tailscaleInfoFromStatus(JSON.parse(status.stdout)).dnsName;
  const serve = await command(tailscale, ['serve', 'status', '--json']);
  const state = tailscaleServePortState(JSON.parse(serve.stdout), host, options.httpsPort, options.bridgePort);
  if (state !== 'empty') throw new Error('Tailscale port is already configured. Choose another HTTPS port; existing handlers were preserved');
  await freePort(options.bridgePort);
  await assertPrivateDirectory(directory);
  if (process.platform === 'win32') {
    const identity = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
    const sid = identity.stdout.trim();
    if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('Could not determine current Windows user');
    await command('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  }
  const credentials = { bridgeToken: randomBytes(32).toString('base64url'), pairingPassphrase: randomBytes(24).toString('base64url') };
  await writeFile(credentialsPath, JSON.stringify(credentials) + '\n', { mode: 0o600, flag: 'wx' });
  const config = { ...options, host }; delete config.dryRun;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (process.platform === 'linux') {
    await mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 });
    await writeFile(unitPath, systemdUnit(process.execPath, runner, configPath), { mode: 0o600, flag: 'wx' });
    await command('systemctl', ['--user', 'daemon-reload']);
    await command('systemctl', ['--user', 'enable', '--now', 'even-t3-bridge.service']);
  } else {
    const script = windowsTaskScript(process.execPath, runner, configPath);
    await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  }
  const deadline = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${options.bridgePort}/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.ok) { healthy = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!healthy) throw new Error('Startup was installed but health verification failed. Inspect the user service; private configuration was retained and Tailscale was not changed');
  const { verifyLocalPairing } = await import('./portable-deployment.mjs');
  await verifyLocalPairing(options.bridgePort, credentials);
  // Publish only after the authenticated loopback service is healthy; recheck the mapping.
  const finalServe = await command(tailscale, ['serve', 'status', '--json']);
  if (tailscaleServePortState(JSON.parse(finalServe.stdout), host, options.httpsPort, options.bridgePort) !== 'empty') throw new Error('Tailscale handler changed during install; nothing was replaced');
  await command(tailscale, ['serve', '--bg', `--https=${options.httpsPort}`, `http://127.0.0.1:${options.bridgePort}`]);
  console.log(JSON.stringify({ ...connectionInfo(config), pairingPassphraseFile: credentialsPath, configurationFile: configPath, autostart: 'At desktop user login. T3 Code must also be running.', status: 'Loopback health and pairing verified; verify T3 and Whisper from the app.' }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
