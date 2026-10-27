import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface LauncherConfig { bridgeOrigin: string; codexPath: string; workspaceRoot: string; launcherToken: string }
export function validateLauncherConfig(value: unknown): LauncherConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid Faceclaw launcher configuration');
  const config = value as LauncherConfig;
  const url = new URL(config.bridgeOrigin);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== config.bridgeOrigin || url.username || url.password ||
      typeof config.codexPath !== 'string' || !isAbsolute(config.codexPath) || typeof config.workspaceRoot !== 'string' || !isAbsolute(config.workspaceRoot) ||
      typeof config.launcherToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(config.launcherToken)) throw new Error('Invalid Faceclaw launcher configuration');
  return config;
}

export async function readLauncherConfig(path: string): Promise<LauncherConfig> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 8192 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error('Faceclaw launcher configuration must be a private owner-only file');
    }
    return validateLauncherConfig(JSON.parse(await handle.readFile('utf8')));
  } finally { await handle.close(); }
}

async function post(config: LauncherConfig, path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(config.bridgeOrigin + path, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Faceclaw provider connection failed'); }
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (!response.body) throw new Error('Invalid Faceclaw provider response');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 8192) throw new Error('Invalid Faceclaw provider response');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

/** Keep T3's per-process protocol stream intact while preventing a granted
 * provider from changing to another project via thread/start/resume/fork. */
export function forwardScopedInput(child: ChildProcess, workspaceRoot: string, onFailure: () => void): void {
  let buffer = '';
  let pending = Promise.resolve();
  let queued = 0;
  let stopped = false;
  const fail = () => { if (!stopped) { stopped = true; process.stdin.pause(); onFailure(); } };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data: string) => {
    if (stopped) return;
    buffer += data;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { fail(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (++queued > 64) { fail(); return; }
      pending = pending.then(async () => {
        if (stopped) return;
        const request = JSON.parse(line) as { method?: string; params?: { cwd?: unknown } };
        if (['thread/start', 'thread/resume', 'thread/fork', 'turn/start'].includes(request.method ?? '') && request.params?.cwd != null) {
          const cwd = request.params.cwd;
          if (typeof cwd !== 'string' || !isAbsolute(cwd) || await realpath(cwd) !== workspaceRoot) throw new Error('Provider project changed');
        }
        if (!child.stdin?.write(line + '\n')) await new Promise<void>(resolve => child.stdin?.once('drain', resolve));
        queued--;
      }).catch(fail);
    }
  });
  process.stdin.on('end', () => { void pending.then(() => child.stdin?.end()); });
}

export async function runFaceclawLauncher(configPath: string, args: string[]): Promise<void> {
  const config = await readLauncherConfig(configPath);
  const scoped = args.includes('app-server') && await realpath(process.cwd()) === await realpath(config.workspaceRoot);
  let grant: Record<string, unknown> | null = null;
  if (scoped) grant = await post(config, '/v1/faceclaw/provider-session', config.launcherToken, { cwd: process.cwd() });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('BRIDGE_') || name.startsWith('FACECLAW_')) delete env[name];
  const launchArgs = [...args];
  if (grant) {
    if (typeof grant.token !== 'string' || !grant.token.startsWith('fc1.')) throw new Error('Invalid Faceclaw provider capability');
    env.FACECLAW_SESSION_TOKEN = grant.token;
    launchArgs.push('-c', `mcp_servers.faceclaw={url=${JSON.stringify(config.bridgeOrigin + '/v1/faceclaw/mcp')},bearer_token_env_var="FACECLAW_SESSION_TOKEN",required=true}`);
  }
  const child = spawn(config.codexPath, launchArgs, { cwd: process.cwd(), env, stdio: ['pipe', 'inherit', 'inherit'], detached: process.platform !== 'win32' });
  let failed = false;
  let killTimer: NodeJS.Timeout | null = null;
  const terminate = () => {
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ } };
    kill('SIGTERM');
    killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
    killTimer.unref();
  };
  const stop = () => { failed = true; terminate(); };
  if (grant) forwardScopedInput(child, await realpath(config.workspaceRoot), stop);
  else process.stdin.pipe(child.stdin!);
  const renewal = grant ? setInterval(() => {
    void post(config, '/v1/faceclaw/provider-renew', grant!.token as string, { leaseToken: grant!.leaseToken }).catch(stop);
  }, 30_000) : null;
  const signal = () => { terminate(); };
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  child.stdin?.on('error', () => {});
  const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('close', result => resolve(result ?? 1)); });
  if (killTimer) clearTimeout(killTimer);
  if (renewal) clearInterval(renewal);
  if (grant) await post(config, '/v1/faceclaw/provider-revoke', grant.token as string, { leaseToken: grant.leaseToken }).catch(() => {});
  process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal);
  process.stdin.destroy();
  process.exitCode = failed ? 1 : code;
}
