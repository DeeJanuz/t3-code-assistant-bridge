import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ApiError } from './security.js';
import { PEER_READS, peerRecord } from './peer-operations.js';
import { PEER_VERSION, type PeerEntry, type PeerIdentity } from './peer-store.js';
import type { T3Client, T3Descriptor, T3ModelCatalog, T3ShellSnapshot, T3ThreadSnapshot } from './types.js';

export const PEER_PROTOCOL = 'faceclaw-peer-v1';
export const PEER_PATH = '/v1/peer/events';
export class PeerT3Client implements T3Client {
  private socket: WebSocket | null = null;
  private closed = false;
  private connecting: Promise<void> | null = null;
  private nextAttempt = 0;
  private failures = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; mutation: boolean }>();
  private shellCache: { value: T3ShellSnapshot; at: number } | null = null;
  private shellPending: Promise<T3ShellSnapshot> | null = null;
  constructor(readonly peer: PeerEntry, private readonly local: PeerIdentity, private readonly maxBytes: number,
    private readonly socketFactory = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, PEER_PROTOCOL, options)) {}
  close(): void { this.closed = true; this.socket?.terminate(); this.socket = null; this.shellCache = null; this.failPending(); }
  private failPending() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ApiError(502, p.mutation ? 'peer_operation_uncertain' : 'environment_unavailable',
        p.mutation ? 'The remote action could not be confirmed. Refresh before trying again.' : 'The remote computer is unavailable'));
    }
    this.pending.clear();
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new ApiError(503, 'peer_revoked', 'Peer connection is closed');
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (Date.now() < this.nextAttempt) throw new ApiError(503, 'environment_unavailable', 'The remote computer is unavailable');
    this.connecting = new Promise<void>((resolve, reject) => {
      const url = new URL(PEER_PATH, this.peer.origin); url.protocol = 'wss:';
      const socket = this.socketFactory(url.href, { headers: { Authorization: `Bearer ${this.peer.outgoingToken}` },
        maxPayload: this.maxBytes, handshakeTimeout: 3000, followRedirects: false });
      this.socket = socket;
      let failed = false;
      const fail = () => {
        if (failed) return; failed = true;
        if (this.socket === socket) this.socket = null;
        this.nextAttempt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(++this.failures, 5));
        this.failPending();
        reject(new ApiError(503, 'environment_unavailable', 'The remote computer is unavailable'));
      };
      socket.on('error', fail);
      socket.on('close', fail);
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw new Error();
          const v = peerRecord(JSON.parse(data.toString()));
          if (v.v !== PEER_VERSION || typeof v.id !== 'string') throw new Error();
          const p = this.pending.get(v.id); if (!p) return;
          if (typeof v.ok !== 'boolean') throw new Error('Malformed peer response');
          const e = v.ok ? null : peerRecord(v.error);
          this.pending.delete(v.id); clearTimeout(p.timer);
          if (v.ok === true) p.resolve(v.result);
          else p.reject(new ApiError(502, typeof e?.code === 'string' && /^[a-z_]{1,64}$/.test(e.code) ? e.code : 'environment_unavailable',
            'The remote operation failed. Refresh the session for its current state.'));
        } catch { socket.terminate(); }
      });
      socket.once('open', () => {
        void this.raw('hello', { bridgeId: this.local.bridgeId, environmentId: this.local.environmentId }).then(value => {
          const v = peerRecord(value);
          if (v.version !== PEER_VERSION || v.bridgeId !== this.peer.bridgeId || v.environmentId !== this.peer.environmentId) {
            socket.terminate(); reject(new ApiError(502, 'peer_identity_mismatch', 'Peer identity or version changed')); return;
          }
          this.failures = 0; this.nextAttempt = 0; resolve();
        }).catch(() => { socket.terminate(); fail(); });
      });
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }
  private raw(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new ApiError(503, 'environment_unavailable', 'Peer is unavailable'));
    if (this.pending.size >= 16) return Promise.reject(new ApiError(429, 'rate_limited', 'Too many peer requests'));
    const id = randomUUID(), mutation = method !== 'hello' && !PEER_READS.has(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError(502, mutation ? 'peer_operation_uncertain' : 'environment_unavailable',
          mutation ? 'The remote action could not be confirmed. Refresh before trying again.' : 'The remote computer did not respond'));
        socket.terminate();
      }, method === 'shell' || method === 'hello' ? 3000 : 15_000);
      this.pending.set(id, { resolve, reject, timer, mutation });
      socket.send(JSON.stringify({ v: PEER_VERSION, id, method, params }));
    });
  }
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    await this.connect(); return await this.raw(method, params) as T;
  }
  async descriptor(): Promise<T3Descriptor> {
    const value = await this.request<T3Descriptor>('descriptor');
    if (value.environmentId !== this.peer.environmentId || value.capabilities?.threadSettlement !== true) throw new ApiError(502, 'peer_identity_mismatch', 'Peer environment changed');
    return value;
  }
  /** Background/coalesced polling keeps a slow peer out of the host's critical path. */
  async refreshShell(): Promise<T3ShellSnapshot> {
    this.shellPending ??= this.request<T3ShellSnapshot>('shell').then(value => {
      if (!Number.isSafeInteger(value.snapshotSequence) || !Array.isArray(value.projects) || !Array.isArray(value.threads)) throw new Error('Invalid peer snapshot');
      this.shellCache = { value, at: Date.now() }; return value;
    });
    try { return await this.shellPending; } finally { this.shellPending = null; }
  }
  async shell(): Promise<T3ShellSnapshot> {
    if (this.shellCache && Date.now() - this.shellCache.at <= 3500) return this.shellCache.value;
    void this.refreshShell().catch(() => undefined);
    throw new ApiError(503, 'environment_unavailable', 'The remote computer is unavailable');
  }
  thread(threadId: string) { return this.request<T3ThreadSnapshot>('thread', { threadId }); }
  threadPage(threadId: string, beforeCursor?: string) { return this.request<T3ThreadSnapshot>('threadPage', { threadId, beforeCursor }); }
  modelCatalog() { return this.request<T3ModelCatalog>('modelCatalog'); }
  private async mutate(method: string, params: unknown): Promise<{ sequence: number }> {
    let result: { sequence: number };
    try { result = await this.request(method, params); }
    catch (error) { this.shellCache = null; void this.refreshShell().catch(() => undefined); throw error; }
    // Finish any poll begun before the mutation, then obtain its resulting state.
    // Keep the bounded existing snapshot available to other clients meanwhile.
    await this.shellPending?.catch(() => undefined);
    await this.refreshShell().catch(() => undefined);
    return result;
  }
  startSession(p: Parameters<T3Client['startSession']>[0]) { return this.mutate('startSession', { projectId: p.project.id, threadId: p.threadId, text: p.text, selection: p.selection }); }
  sendMessage(p: Parameters<T3Client['sendMessage']>[0]) { return this.mutate('sendMessage', { threadId: p.thread.id, text: p.text, interactionMode: p.interactionMode, reasoningId: p.reasoningId }); }
  steerMessage(p: Parameters<T3Client['steerMessage']>[0]) { return this.mutate('steerMessage', { threadId: p.thread.id, text: p.text }); }
  async replyMessage(p: Parameters<T3Client['replyMessage']>[0]) {
    const params = { threadId: p.thread.id, text: p.text };
    try { return await this.mutate('replyMessage', params); }
    catch (error) {
      // Older paired bridges predate the atomic reply operation. Their
      // method_not_found response proves that nothing was dispatched, so a
      // legacy send/steer fallback is safe. Never retry an uncertain result.
      if (!(error instanceof ApiError) || error.code !== 'method_not_found') throw error;
    }
    const active = ['running', 'starting'].includes(p.thread.session?.status ?? '') ||
      p.thread.session?.activeTurnId != null || p.thread.latestTurn?.state === 'running';
    const first = active ? 'steerMessage' : 'sendMessage';
    const second = active ? 'sendMessage' : 'steerMessage';
    try { return await this.mutate(first, params); }
    catch (error) {
      const stateChanged = error instanceof ApiError &&
        ((first === 'steerMessage' && error.code === 'session_not_running') ||
         (first === 'sendMessage' && error.code === 'session_busy'));
      if (!stateChanged) throw error;
      return this.mutate(second, params);
    }
  }
  settleThread(threadId: string) { return this.mutate('settleThread', { threadId }); }
  respondToPlanInput(p: Parameters<T3Client['respondToPlanInput']>[0]) { return this.mutate('respondToPlanInput', p); }
  setModel(p: Parameters<NonNullable<T3Client['setModel']>>[0]) { return this.mutate('setModel', { threadId: p.thread.id, selection: p.selection, expectedModel: { instanceId: p.thread.modelSelection.instanceId, model: p.thread.modelSelection.model } }); }
  setReasoning(p: Parameters<NonNullable<T3Client['setReasoning']>>[0]) { return this.mutate('setReasoning', { threadId: p.thread.id, reasoningId: p.reasoningId, expectedModel: { instanceId: p.thread.modelSelection.instanceId, model: p.thread.modelSelection.model } }); }
  approvePlan(p: Parameters<NonNullable<T3Client['approvePlan']>>[0]) { return this.mutate('approvePlan', { threadId: p.thread.id, planId: p.planId, planMarkdown: p.planMarkdown, commandId: p.commandId }); }
}
