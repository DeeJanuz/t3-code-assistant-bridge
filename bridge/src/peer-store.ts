import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, isSafeId } from './security.js';
import { peerRecord } from './peer-operations.js';

export const PEER_VERSION = 1;
export const peerSecret = () => randomBytes(32).toString('base64url');
export const peerHash = (s: string) => createHash('sha256').update(s).digest('hex');
export function peerOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected an HTTPS Tailscale origin');
  const u = new URL(value);
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/i.test(u.hostname) ||
      u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Expected an HTTPS Tailscale origin');
  return u.origin;
}
export interface PeerIdentity { bridgeId: string; environmentId: string; label: string; origin: string }
export interface PeerEntry extends PeerIdentity {
  incomingHash: string;
  outgoingToken: string;
  state: 'pending' | 'paired';
  transactionId: string;
}
interface Invitation { hash: string; expiresAt: number; peerId?: string; requestHash?: string; responseToken?: string }
export interface PeerState {
  version: 1;
  identity: PeerIdentity;
  peers: PeerEntry[];
  invitations: Record<string, Invitation>;
}
export interface PeerInvitation { version: 1; identity: PeerIdentity; id: string; secret: string; expiresAt: number }
export function identity(value: unknown): PeerIdentity {
  const v = peerRecord(value);
  if (typeof v.bridgeId !== 'string' || !isSafeId(v.bridgeId) || typeof v.environmentId !== 'string' || !isSafeId(v.environmentId) ||
      typeof v.label !== 'string' || !v.label.trim() || v.label.length > 256 || /[\x00-\x1f\x7f]/.test(v.label)) throw new Error('Invalid peer identity');
  return { bridgeId: v.bridgeId, environmentId: v.environmentId, label: v.label, origin: peerOrigin(v.origin) };
}
export function validPeerToken(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v); }

/** A private directory is also the trust boundary for atomic configuration replacement. */
export async function protectPeerDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const first = await lstat(directory);
  if (!first.isDirectory() || first.isSymbolicLink()) throw new Error('Invalid peer directory');
  if (process.platform === 'win32') {
    const run = promisify(execFile);
    const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.match(/S-1-5-[\d-]+/)?.[0];
    if (!sid) throw new Error('Cannot identify peer credential owner');
    await run('icacls.exe', [directory, '/reset']);
    await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid peer directory');
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Error('Peer directory must be owner-only (0700)');
}
// A PowerShell 7 parent sets PSModulePath to its own modules, which stops
// Windows PowerShell 5.1 from loading built-ins such as Get-Acl.
export function windowsPowerShellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}
const checkedWindowsFiles = new Set<string>();
async function verifyWindowsOwner(file: string): Promise<void> {
  if (process.platform !== 'win32' || checkedWindowsFiles.has(file)) return;
  const literal = file.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath '${literal}'; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 1}; foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 1}}`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: windowsPowerShellEnvironment(), windowsHide: true });
  checkedWindowsFiles.add(file);
}
export async function readPeerFile(file: string): Promise<string> {
  await verifyWindowsOwner(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1_048_576 ||
        (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw new Error('Unsafe peer credential file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export async function writePeerFile(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}
export class PeerStore {
  readonly file: string;
  constructor(readonly directory: string) { this.file = join(directory, 'peers.json'); }
  async read(): Promise<PeerState> {
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' &&
        (directory.uid !== process.getuid?.() || (directory.mode & 0o077)))) throw new Error('Unsafe peer directory');
    await verifyWindowsOwner(this.directory);
    const v = JSON.parse(await readPeerFile(this.file)) as PeerState;
    if (v.version !== 1 || !Array.isArray(v.peers) || v.peers.length > 32 || !v.invitations) throw new Error('Invalid peer configuration');
    identity(v.identity);
    const ids = new Set<string>(), environments = new Set<string>(), origins = new Set<string>();
    for (const p of v.peers) {
      identity(p);
      if (ids.has(p.bridgeId) || origins.has(p.origin) || environments.has(p.environmentId) || p.bridgeId === v.identity.bridgeId || p.environmentId === v.identity.environmentId ||
          !validPeerToken(p.outgoingToken) || !/^[a-f0-9]{64}$/.test(p.incomingHash) || !['paired', 'pending'].includes(p.state)) throw new Error('Invalid peer configuration');
      ids.add(p.bridgeId); environments.add(p.environmentId); origins.add(p.origin);
    }
    return v;
  }
  async update<T>(change: (state: PeerState) => T | Promise<T>): Promise<T> {
    const lock = join(this.directory, 'write.lock');
    let acquired = false;
    for (let i = 0; i < 50; i++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    if (!acquired) throw new Error('Peer store is locked; inspect the owner process before removing write.lock');
    try { const state = await this.read(); const result = await change(state); await writePeerFile(this.file, state); return result; }
    finally { await rm(lock, { recursive: true }); }
  }
  async initialize(value: Omit<PeerIdentity, 'bridgeId'>): Promise<void> {
    await protectPeerDirectory(this.directory);
    const handle = await open(this.file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, identity: identity({ ...value, bridgeId: randomUUID() }), peers: [], invitations: {} })); await handle.sync(); }
    finally { await handle.close(); }
  }
  async invite(): Promise<PeerInvitation> {
    return this.update(state => {
      const now = Date.now();
      for (const [id, invite] of Object.entries(state.invitations)) if (invite.expiresAt <= now) delete state.invitations[id];
      if (Object.keys(state.invitations).length >= 16) throw new Error('Too many pending invitations');
      const id = randomUUID(), secret = peerSecret(), expiresAt = now + 300_000;
      state.invitations[id] = { hash: peerHash(secret), expiresAt };
      return { version: 1, identity: state.identity, id, secret, expiresAt };
    });
  }
  async accept(input: unknown): Promise<{ identity: PeerIdentity; token: string }> {
    const p = peerRecord(input), remote = identity(p.identity);
    if (p.version !== 1 || typeof p.id !== 'string' || !isSafeId(p.id) || !validPeerToken(p.secret) || !validPeerToken(p.token)) throw new Error('Invalid invitation');
    const invitationId = p.id, secret = p.secret, token = p.token;
    return this.update(state => {
      const invite = state.invitations[invitationId];
      if (!invite || invite.expiresAt <= Date.now() || invite.hash !== peerHash(secret)) throw new ApiError(401, 'peer_pairing_denied', 'Invitation expired or invalid');
      const requestHash = peerHash(JSON.stringify([remote, token]));
      if (invite.peerId) {
        if (invite.peerId !== remote.bridgeId || invite.requestHash !== requestHash || !invite.responseToken || !state.peers.some(x => x.bridgeId === remote.bridgeId)) throw new Error('Invitation already used');
        return { identity: state.identity, token: invite.responseToken };
      }
      this.assertNew(state, remote);
      const responseToken = peerSecret();
      state.peers.push({ ...remote, incomingHash: peerHash(responseToken), outgoingToken: token, state: 'pending', transactionId: invitationId });
      Object.assign(invite, { peerId: remote.bridgeId, requestHash, responseToken });
      return { identity: state.identity, token: responseToken };
    });
  }
  assertNew(state: PeerState, remote: PeerIdentity): void {
    if (state.peers.length >= 32 || remote.bridgeId === state.identity.bridgeId || remote.environmentId === state.identity.environmentId ||
        state.peers.some(p => p.bridgeId === remote.bridgeId || p.environmentId === remote.environmentId || p.origin === remote.origin)) throw new Error('Peer or environment already enrolled');
  }
  async authorize(token: string, pending = false): Promise<PeerEntry | undefined> {
    if (!validPeerToken(token)) return undefined;
    return (await this.read()).peers.find(p => p.incomingHash === peerHash(token) && (pending || p.state === 'paired'));
  }
  async confirm(token: string): Promise<PeerIdentity> {
    return this.update(state => {
      const peer = state.peers.find(p => p.incomingHash === peerHash(token));
      if (!peer) throw new ApiError(401, 'peer_pairing_denied', 'Peer is not authorized');
      peer.state = 'paired';
      return state.identity;
    });
  }
  async revoke(bridgeId: string): Promise<void> {
    await this.update(state => {
      state.peers = state.peers.filter(p => p.bridgeId !== bridgeId);
      for (const [id, invite] of Object.entries(state.invitations)) if (invite.peerId === bridgeId) delete state.invitations[id];
    });
  }
}
