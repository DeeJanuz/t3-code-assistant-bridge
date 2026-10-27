import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { ApiError } from './security.js';

export interface SignalTransport {
  readonly ready: boolean;
  readonly health: string;
  start(receive: (value: unknown) => void): void;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number, onLateResult?: (result: unknown) => void): Promise<unknown>;
  stop(): void;
  resetData?(): Promise<void>;
}

/** No shell, TCP listener, inherited Signal configuration, message logs or auto-replay.
 * Child stderr is drained and discarded: signal-cli can print personal identifiers.
 */
export class SignalCli implements SignalTransport {
  ready = false;
  health = 'stopped';
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = true;
  private restart: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private sequence = 0;
  private receive: (value: unknown) => void = () => {};
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly executable: string, private readonly directory: string) {
    if (!isAbsolute(executable)) throw new Error('Signal CLI executable must be an absolute path');
  }
  start(receive: (value: unknown) => void): void {
    if (!this.stopped) return;
    this.receive = receive; this.stopped = false; this.launch();
  }
  private launch(): void {
    if (this.stopped) return;
    this.health = 'starting';
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      this.stopped = true; this.health = 'insecure-data-directory'; return;
    }
    // Separate config roots prevent accidentally receiving through a pre-existing account.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
      HOME: this.directory, XDG_CONFIG_HOME: join(this.directory, 'config'), XDG_DATA_HOME: join(this.directory, 'data') };
    const child = spawn(this.executable, ['--data-dir', this.directory, '--scrub-log', '--log-file', '/dev/null', '--disable-send-log',
      'jsonRpc', '--receive-mode=manual', '--ignore-attachments', '--ignore-avatars', '--ignore-stickers', '--ignore-stories'],
    { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = Buffer.alloc(0);
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 2 * 1024 * 1024) { this.health = 'invalid-output'; child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        try {
          const value = JSON.parse(line.toString()) as Record<string, unknown>;
          if (value.method === 'receive') this.receive(value.params);
          else if (typeof value.id === 'string') {
            const call = this.pending.get(value.id);
            if (call) { clearTimeout(call.timer); this.pending.delete(value.id);
              if (value.error) call.reject(new ApiError(502, 'signal_cli_error', 'Signal CLI rejected the operation; inspect account health'));
              else call.resolve(value.result);
            }
          }
        } catch { this.health = 'invalid-output'; child.kill(); return; }
      }
    });
    let ended = false;
    const end = () => {
      if (ended) return; ended = true;
      this.ready = false;
      this.health = this.stopped ? 'stopped' : ['starting', 'ready'].includes(this.health) ? 'unavailable' : this.health; this.child = null;
      for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new ApiError(503, 'signal_offline', 'Signal service disconnected')); }
      this.pending.clear();
      if (!this.stopped) { this.restart = setTimeout(() => this.launch(), this.backoff); this.restart.unref(); this.backoff = Math.min(60_000, this.backoff * 2); }
    };
    child.once('error', error => { this.health = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'signal-cli-not-found' : 'signal-cli-start-failed'; end(); }); child.once('close', end);
    child.once('spawn', () => {
      void this.request('version').then(async result => {
        const version = typeof result === 'string' ? result : String((result as { version?: string })?.version ?? '');
        if (version !== '0.14.7') throw new Error('Unsupported signal-cli version');
        await this.request('subscribeReceive');
        this.ready = true; this.health = 'ready'; this.backoff = 1000;
      }).catch(() => { this.health = 'requires-signal-cli-0.14.7-and-Java-25'; child.kill(); });
    });
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, onLateResult?: (result: unknown) => void): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || this.pending.size >= 32) return Promise.reject(new ApiError(503, 'signal_offline', 'Signal service is unavailable'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Retain only a bounded reconciliation callback, never replay the request.
        if (onLateResult) {
          const lateTimer = setTimeout(() => this.pending.delete(id), 120_000); lateTimer.unref();
          this.pending.set(id, { resolve: onLateResult, reject: () => {}, timer: lateTimer });
        }
        reject(new ApiError(504, 'signal_timeout', 'Signal operation outcome is unknown'));
      }, timeoutMs);
      timer.unref(); this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new ApiError(503, 'signal_offline', 'Signal service disconnected')); }
      });
    });
  }
  stop(): void {
    this.stopped = true; this.ready = false;
    if (this.restart) clearTimeout(this.restart);
    const child = this.child;
    if (child) { child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 3000); kill.unref(); child.once('close', () => clearTimeout(kill)); }
  }
  async resetData(): Promise<void> {
    const child = this.child;
    const closed = child ? new Promise<void>(resolve => child.once('close', () => resolve())) : Promise.resolve();
    this.stop(); await closed;
    let files = 0, bytes = 0;
    const inspect = (path: string): void => {
      const stat = lstatSync(path);
      if (++files > 10_000 || (bytes += stat.size) > 256 * 1024 * 1024) throw new ApiError(409, 'reset_limit', 'Signal data is too large for automatic reset; remove offline');
      if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(path)) inspect(join(path, name));
    };
    inspect(this.directory);
    rmSync(this.directory, { recursive: true });
  }
}
