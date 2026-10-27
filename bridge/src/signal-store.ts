import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

export interface SignalConversation { id: string; title: string; kind: 'direct' | 'group'; target: string; disappearing: boolean; expirationSeconds: number; self?: boolean }
export interface SignalMessage { id: string; conversationId: string; sender: string; author: string; text: string; timestamp: number; expiresAt: number; outgoing: boolean }
export interface SignalDraft { conversationId: string; text: string; expiresAt: number; owner: string; version: string }
export interface SignalOperation { operationId: string; conversationId: string; status: 'pending' | 'sent' | 'unknown'; timestamp?: number; fingerprint: string; owner: string; createdAt: number }
export interface SignalCredential { id: string; digest: string; kind: 'app' | 'assistant'; conversations: string[]; accountId: string }
export interface SignalEvent { sequence: number; type: 'message' | 'remove' | 'operation' | 'conversation'; messageId?: string; operationId?: string; conversationId?: string }
export interface SignalState {
  version: 1; accountId: string | null; retentionDays: number; preview: 'message' | 'sender'; sequence: number;
  conversations: SignalConversation[]; messages: SignalMessage[]; drafts: SignalDraft[]; operations: SignalOperation[];
  credentials: SignalCredential[]; events: SignalEvent[]; tombstones: { id: string; until: number }[];
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const newSignalState = (): SignalState => ({ version: 1, accountId: null, retentionDays: 30, preview: 'message', sequence: 0,
  conversations: [], messages: [], drafts: [], operations: [], credentials: [], events: [], tombstones: [] });

/** Single bridge process, atomic encrypted snapshots. No SQL or migration of existing T3 data.
 * Version mismatches and corrupt state fail closed. The lock prevents mixed writers.
 * A durable send intent is committed before any network side effect. No automatic backups.
 */
export class SignalStore {
  state: SignalState;
  private key: Buffer;
  private lock: number;
  private closed = false;
  constructor(readonly directory: string) {
    if (!isAbsolute(directory) || normalize(directory) !== directory) throw new Error('Signal data directory must be normalized and absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.checkPrivate(directory, true);
    const lockPath = join(directory, 'writer.lock');
    // Serialize stale-lock recovery too: concurrent restarts must not unlink a
    // newly acquired writer lock after both observing a dead PID.
    const recoveryPath = join(directory, 'recovery.lock');
    const recovery = openSync(recoveryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      if (existsSync(lockPath)) {
        this.checkPrivate(lockPath);
        const pid = Number(readFileSync(lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Signal writer lock; inspect offline');
        try { process.kill(pid, 0); throw new Error('Signal data directory is already in use'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        unlinkSync(lockPath);
      }
      this.lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(this.lock, String(process.pid)); fsyncSync(this.lock);
    } finally { closeSync(recovery); unlinkSync(recoveryPath); }
    try {
      const keyPath = join(directory, 'storage.key');
      const statePath = join(directory, 'state.enc');
      if (!existsSync(keyPath)) {
        if (existsSync(statePath)) throw new Error('Signal storage key is missing; restore matching key offline');
        writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      }
      this.checkPrivate(keyPath);
      this.key = readFileSync(keyPath);
      if (this.key.length !== 32) throw new Error('Invalid Signal storage key');
      if (existsSync(statePath)) {
        this.checkPrivate(statePath);
        if (lstatSync(statePath).size > 32 * 1024 * 1024) throw new Error('Signal state exceeds storage limit');
        const raw = readFileSync(statePath);
        if (raw.subarray(0, 4).toString() !== 'FCS1') throw new Error('Unsupported Signal storage envelope');
        const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(4, 16));
        decipher.setAAD(Buffer.from('faceclaw-signal-state-v1')); decipher.setAuthTag(raw.subarray(16, 32));
        this.state = JSON.parse(Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]).toString()) as SignalState;
        if (this.state.version !== 1 || !Array.isArray(this.state.operations) || !Array.isArray(this.state.messages)) throw new Error('Unsupported Signal schema; do not downgrade');
      } else this.state = newSignalState();
      // A crash after persisting intent may have delivered. Never replay it.
      for (const op of this.state.operations) if (op.status === 'pending') op.status = 'unknown';
      this.commit();
    } catch (error) { closeSync(this.lock); unlinkSync(lockPath); throw error; }
  }
  private checkPrivate(path: string, directory = false): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('Signal storage must be owner-only and contain no symlinks');
  }
  /** Persist before returning success. A failed commit poisons this store until restart. */
  commit(): void {
    if (this.closed) throw new Error('Signal store is closed');
    const raw = Buffer.from(JSON.stringify(this.state));
    if (raw.length > 30 * 1024 * 1024) throw new Error('Signal storage is full');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('faceclaw-signal-state-v1'));
    const content = Buffer.concat([cipher.update(raw), cipher.final()]); raw.fill(0);
    const temp = join(this.directory, `state-${randomBytes(12).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, Buffer.concat([Buffer.from('FCS1'), iv, cipher.getAuthTag(), content])); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, join(this.directory, 'state.enc'));
      const dir = openSync(this.directory, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      this.closed = true;
      throw error;
    }
  }
  event(event: Omit<SignalEvent, 'sequence'>): void {
    this.state.events.push({ ...event, sequence: ++this.state.sequence });
    if (this.state.events.length > 1024) this.state.events.splice(0, this.state.events.length - 1024);
  }
  fingerprint(value: string): string { return createHmac('sha256', this.key).update('signal-operation-v1:').update(value).digest('hex'); }
  prune(now: number): void {
    if (this.closed) throw new Error('Signal store is closed');
    const removed = this.state.messages.filter(m => m.expiresAt <= now);
    for (const message of removed) this.remove(message.id, now);
    const old = this.state.drafts.length, oldTombstones = this.state.tombstones.length;
    this.state.drafts = this.state.drafts.filter(d => d.expiresAt > now);
    this.state.tombstones = this.state.tombstones.filter(t => t.until > now);
    if (removed.length || old !== this.state.drafts.length || oldTombstones !== this.state.tombstones.length) this.commit();
  }
  remove(id: string, now: number): void {
    const message = this.state.messages.find(m => m.id === id);
    this.state.messages = this.state.messages.filter(m => m.id !== id);
    if (!this.state.tombstones.some(t => t.id === id)) {
      if (this.state.tombstones.length >= 50_000) throw new Error('Signal tombstone ledger is full; stop receiving until retention cleanup');
      this.state.tombstones.push({ id, until: now + 366 * 86400_000 });
    }
    if (message) this.state.drafts = this.state.drafts.filter(d => d.conversationId !== message.conversationId);
    this.event({ type: 'remove', messageId: id });
    if (message) this.event({ type: 'conversation', conversationId: message.conversationId });
  }
  close(): void {
    this.key?.fill(0);
    if (this.lock !== -1) { closeSync(this.lock); this.lock = -1; unlinkSync(join(this.directory, 'writer.lock')); }
    this.closed = true;
  }
}
