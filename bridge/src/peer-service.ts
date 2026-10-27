import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { watch, type FSWatcher } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { ApiError, FixedWindowRateLimiter } from './security.js';
import { peerOperation, peerRecord, PEER_READS } from './peer-operations.js';
import { PeerStore, PEER_VERSION, type PeerEntry, type PeerIdentity } from './peer-store.js';
import { PEER_PATH, PEER_PROTOCOL, PeerT3Client } from './peer-client.js';
import type { ManagedEnvironmentRouter, EnvironmentRegistration } from './environment-router.js';
import type { BridgeConfig } from './types.js';

export type PeerClientFactory = (peer: PeerEntry, local: PeerIdentity, maxBytes: number) => PeerT3Client;

/** Peer authority is local T3 only. This service never dispatches via the aggregate router. */
export class PeerService {
  private readonly store: PeerStore;
  private readonly server: WebSocketServer;
  private readonly limiter = new FixedWindowRateLimiter(600);
  private readonly incoming = new Map<WebSocket, string>();
  private readonly outgoing = new Map<string, PeerT3Client>();
  private timer: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private stopped = false;
  private syncing = false;
  private readonly work = new Set<string>();
  private lastStatus = '';
  constructor(private readonly config: BridgeConfig, private readonly router: ManagedEnvironmentRouter, directory: string, private readonly clientFactory: PeerClientFactory = (peer, local, maxBytes) => new PeerT3Client(peer, local, maxBytes)) {
    this.store = new PeerStore(directory);
    this.server = new WebSocketServer({ noServer: true, maxPayload: Math.min(config.maxUpstreamBytes, 1_048_576),
      handleProtocols: protocols => protocols.has(PEER_PROTOCOL) ? PEER_PROTOCOL : false });
    try { this.watcher = watch(directory, () => { void this.reconcileAuthorization(); }); } catch { /* reported as unavailable by sync */ }
    void this.sync();
  }
  private async reconcileAuthorization() {
    let entries: PeerEntry[] = [];
    try { entries = (await this.store.read()).peers.filter(p => p.state === 'paired'); } catch { /* fail closed */ }
    for (const [socket, hash] of this.incoming) if (!entries.some(p => p.incomingHash === hash)) socket.terminate();
    for (const [id, client] of this.outgoing) if (!entries.some(p => p.bridgeId === id && JSON.stringify(p) === JSON.stringify(client.peer))) {
      client.close(); this.outgoing.delete(id); this.router.removeEnvironment(client.peer.environmentId, 'peer');
    }
  }
  private async sync() {
    if (this.stopped || this.syncing) return;
    this.syncing = true;
    try {
      await this.reconcileAuthorization();
      const state = await this.store.read();
      const previous = await this.router.list();
      const registrations: EnvironmentRegistration[] = state.peers.map(peer => {
        const fallback = { environmentId: peer.environmentId, label: peer.label, serverVersion: 'unknown', capabilities: { threadSettlement: true } };
        let client = this.outgoing.get(peer.bridgeId);
        if (peer.state === 'paired' && !client) { client = this.clientFactory(peer, state.identity, this.config.maxUpstreamBytes); this.outgoing.set(peer.bridgeId, client); }
        const old = previous.find(e => e.environmentId === peer.environmentId && e.kind === 'peer');
        const connected = peer.state === 'paired' && old?.status === 'connected' && client;
        if (client && peer.state === 'paired' && !this.work.has(peer.bridgeId)) {
          this.work.add(peer.bridgeId);
          const current = client;
          void (async () => {
            let registration: EnvironmentRegistration;
            try {
              const [descriptor] = await Promise.all([current.descriptor(), current.refreshShell()]);
              registration = { descriptor: { ...descriptor, label: peer.label }, kind: 'peer', client: current, status: 'connected' };
            } catch (e) {
              registration = { descriptor: fallback, kind: 'peer', client: null, status: 'offline', errorCode: e instanceof ApiError ? e.code : 'environment_unavailable' };
            }
            const latest = await this.store.read();
            if (!this.stopped && latest.peers.some(p => JSON.stringify(p) === JSON.stringify(peer)) &&
                !(await this.router.list()).some(e => e.environmentId === peer.environmentId && e.isPrimary)) this.router.register(registration);
          })().catch(() => undefined).finally(() => this.work.delete(peer.bridgeId));
        }
        return { descriptor: { ...fallback, serverVersion: old?.serverVersion ?? 'unknown' }, kind: 'peer',
          client: connected ? client! : null, status: connected ? 'connected' : 'offline',
          ...(peer.state !== 'paired' ? { errorCode: 'peer_pairing_pending' } : old?.errorCode ? { errorCode: old.errorCode } : {}) };
      });
      this.router.replaceKind('peer', registrations);
      const status = JSON.stringify(registrations.map(r => [r.descriptor.environmentId, r.status, r.errorCode]));
      if (status !== this.lastStatus) {
        this.lastStatus = status;
        process.stdout.write(JSON.stringify({ level: 'info', message: 'Peer availability changed',
          connected: registrations.filter(r => r.status === 'connected').length, total: registrations.length }) + '\n');
      }
    } catch {
      this.router.markKindUnavailable('peer', 'peer_configuration_unavailable');
      if (this.lastStatus !== 'configuration-error') {
        this.lastStatus = 'configuration-error';
        process.stderr.write('Peer configuration unavailable; local T3 remains independent.\n');
      }
    } finally {
      this.syncing = false;
      if (!this.stopped) { this.timer = setTimeout(() => void this.sync(), 1000); this.timer.unref(); }
    }
  }
  async http(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid');
    if (!url.pathname.startsWith('/v1/peer/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    try {
      if (url.search || request.headers.origin !== undefined || request.method !== 'POST' ||
          !['/v1/peer/pair', '/v1/peer/confirm'].includes(url.pathname)) throw new ApiError(403, 'peer_denied', 'Peer request denied');
      if (!this.limiter.allow(request.socket.remoteAddress ?? 'unknown')) throw new ApiError(429, 'rate_limited', 'Too many peer requests');
      request.setTimeout(5000, () => request.destroy());
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length; if (bytes > 16_384) throw new ApiError(413, 'invalid_request', 'Peer request too large'); chunks.push(chunk);
      }
      const data = peerRecord(JSON.parse(Buffer.concat(chunks).toString()));
      const local = await this.router.primary();
      const state = await this.store.read();
      if (local.environment.environmentId !== state.identity.environmentId) throw new ApiError(409, 'peer_identity_mismatch', 'Local environment changed');
      const result = url.pathname === '/v1/peer/pair' ? await this.store.accept(data)
        : await this.store.confirm(this.bearer(request));
      response.statusCode = 200; response.end(JSON.stringify(result));
    } catch (e) {
      response.statusCode = e instanceof ApiError ? e.status : 400;
      response.end(JSON.stringify({ error: { code: e instanceof ApiError ? e.code : 'peer_pairing_denied', message: 'Peer pairing could not be completed' } }));
    }
    return true;
  }
  private bearer(request: IncomingMessage): string { return request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? ''; }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid');
    if (!url.pathname.startsWith('/v1/peer/')) return false;
    void (async () => {
      const token = this.bearer(request);
      const peer = await this.store.authorize(token);
      if (!peer || url.pathname !== PEER_PATH || url.search || request.headers.origin !== undefined ||
          request.headers['sec-websocket-protocol'] !== PEER_PROTOCOL || !this.limiter.allow(peer.bridgeId) ||
          this.incoming.size >= 64) throw new Error('Denied');
      this.server.handleUpgrade(request, socket, head, ws => this.connection(ws, token, peer));
    })().catch(() => { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); });
    return true;
  }
  private connection(socket: WebSocket, token: string, peer: PeerEntry) {
    this.incoming.set(socket, peer.incomingHash);
    let hello = false, inFlight = 0;
    const seen = new Set<string>();
    const deadline = setTimeout(() => { if (!hello) socket.terminate(); }, 3000);
    socket.on('close', () => { clearTimeout(deadline); this.incoming.delete(socket); });
    socket.on('error', () => socket.terminate());
    socket.on('message', (data, binary) => {
      if (binary || inFlight >= 16 || !this.limiter.allow(`rpc:${peer.bridgeId}`)) { socket.terminate(); return; }
      inFlight++;
      void (async () => {
        let id: string | undefined;
        let mutation = false;
        try {
          const p = peerRecord(JSON.parse(data.toString()));
          if (p.v !== PEER_VERSION || typeof p.id !== 'string' || !/^[a-f0-9-]{36}$/.test(p.id) ||
              typeof p.method !== 'string' || seen.has(p.id)) throw new Error('Invalid peer message');
          id = p.id;
          if (seen.size >= 4096) { socket.close(1008, 'Reconnect required'); return; }
          seen.add(id);
          if (!await this.store.authorize(token)) throw new ApiError(401, 'peer_revoked', 'Peer revoked');
          const local = await this.router.primary(), state = await this.store.read();
          if (local.environment.environmentId !== state.identity.environmentId) throw new ApiError(409, 'peer_identity_mismatch', 'Environment changed');
          let result: unknown;
          if (p.method === 'hello') {
            const params = peerRecord(p.params);
            if (hello || params.bridgeId !== peer.bridgeId || params.environmentId !== peer.environmentId) throw new Error('Peer identity mismatch');
            hello = true; clearTimeout(deadline);
            result = { version: PEER_VERSION, ...state.identity };
          } else {
            if (!hello) throw new Error('Missing handshake');
            mutation = !PEER_READS.has(p.method);
            result = await peerOperation(local.client, this.config, p.method, p.params);
          }
          if (!await this.store.authorize(token)) { socket.terminate(); return; }
          const output = JSON.stringify({ v: PEER_VERSION, id, ok: true, result });
          if (Buffer.byteLength(output) > this.config.maxUpstreamBytes) throw new ApiError(502, 'upstream_invalid_response', 'Peer response too large');
          if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < this.config.maxUpstreamBytes) socket.send(output);
        } catch (e) {
          if (!id) socket.terminate();
          else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: PEER_VERSION, id, ok: false,
            error: { code: e instanceof ApiError ? e.code : mutation ? 'peer_operation_uncertain' : 'upstream_invalid_response', message: 'Peer operation failed' } }));
        } finally { inFlight--; }
      })();
    });
  }
  close() {
    this.stopped = true; clearTimeout(this.timer); this.watcher?.close();
    for (const socket of this.incoming.keys()) socket.terminate();
    for (const client of this.outgoing.values()) client.close();
    this.server.close();
  }
}
