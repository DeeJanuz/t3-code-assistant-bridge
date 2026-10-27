import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { ApiError, FixedWindowRateLimiter, bearerToken, readJsonBody, secretMatches, sendJson } from './security.js';
import { SignalCli } from './signal-cli.js';
import { SignalService } from './signal-service.js';
import { SignalStore, digest } from './signal-store.js';
import { signalSetupHtml } from './signal-setup.js';
import { signalMcp } from './signal-mcp.js';
import type { BridgeConfig } from './types.js';

/** Signal credentials are deliberately absent from the generic/T3 service registry. */
export class SignalHttp {
  private readonly sessions = new Map<string, number>();
  private readonly loginLimiter = new FixedWindowRateLimiter(5, 300_000);
  private readonly pairingLimiter = new FixedWindowRateLimiter(5, 300_000);
  private readonly reviews = new Map<string, { session: string; credentialId: string; conversationId: string; accountId: string; text: string; draftVersion: string; expiresAt: number }>();
  private cleanup: NodeJS.Timeout | null = null;
  constructor(readonly service: SignalService, private readonly ownerToken: string, private readonly now: () => number = Date.now) {}
  static create(config: BridgeConfig): SignalHttp | null {
    if (!config.signal) return null;
    const store = new SignalStore(config.signal.dataDirectory);
    return new SignalHttp(new SignalService(store, new SignalCli(config.signal.cliPath, join(config.signal.dataDirectory, 'signal-cli'))), config.bridgeToken);
  }
  start(): void {
    this.service.start();
    this.cleanup = setInterval(() => this.prune(), 1000); this.cleanup.unref();
  }
  close(): void { if (this.cleanup) clearInterval(this.cleanup); this.sessions.clear(); this.reviews.clear(); this.service.close(); }
  private prune(): void {
    for (const [key, expiry] of this.sessions) if (expiry <= this.now()) this.sessions.delete(key);
    for (const [key, review] of this.reviews) if (review.expiresAt <= this.now() || !this.sessions.has(review.session) ||
      !this.service.store.state.credentials.some(c => c.id === review.credentialId && c.kind === 'assistant' && c.conversations.includes(review.conversationId)) ||
      !this.service.store.state.drafts.some(d => d.owner === review.credentialId && d.conversationId === review.conversationId && d.version === review.draftVersion)) this.reviews.delete(key);
  }
  private requireLocal(request: IncomingMessage): void {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw new ApiError(403, 'local_setup_only', 'Open setup on the bridge computer');
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(host)) throw new ApiError(403, 'local_setup_only', 'Use the numeric loopback setup URL');
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new ApiError(403, 'origin_denied', 'Invalid setup origin');
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) throw new ApiError(403, 'origin_denied', 'Invalid setup context');
  }
  private session(request: IncomingMessage): string {
    const token = bearerToken(request), key = token ? digest(token) : '';
    const expiresAt = this.sessions.get(key);
    if (!expiresAt || expiresAt <= this.now()) throw new ApiError(401, 'setup_login_required', 'Sign into Signal setup again');
    return key;
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<number | null> {
    this.prune();
    const path = url.pathname;
    if (path !== '/signal/setup' && !path.startsWith('/v1/signal/')) return null;
    if (url.search || url.hash) throw new ApiError(400, 'invalid_request', 'Signal endpoints do not accept URL parameters');
    if (path === '/signal/setup') {
      this.requireLocal(request);
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET');
      const nonce = randomBytes(24).toString('base64');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(signalSetupHtml(nonce)); return 200;
    }
    if (request.method !== 'POST' || !/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] ?? ''))) throw new ApiError(400, 'invalid_request', 'Signal API requires POST application/json');
    if (path === '/v1/signal/admin') {
      this.requireLocal(request);
      const body = await readJsonBody(request, 16_384), method = body.method;
      const params = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params) ? body.params as Record<string, unknown> : {};
      if (method === 'login') {
        if (!this.loginLimiter.allow(request.socket.remoteAddress ?? '')) throw new ApiError(429, 'login_failed', 'Try again later');
        if (typeof params.ownerToken !== 'string' || !secretMatches(params.ownerToken, this.ownerToken)) throw new ApiError(401, 'login_failed', 'Owner credential required');
        for (const [key, expiry] of this.sessions) if (expiry <= this.now()) this.sessions.delete(key);
        if (this.sessions.size >= 8) throw new ApiError(429, 'session_limit', 'Too many setup sessions');
        const token = `fcsadmin_${randomBytes(32).toString('base64url')}`, expiresAt = this.now() + 15 * 60_000;
        this.sessions.set(digest(token), expiresAt); sendJson(response, 200, { token, expiresAt }); return 200;
      }
      const session = this.session(request);
      if (method === 'logout') { this.sessions.delete(session); sendJson(response, 200, { loggedOut: true }); return 200; }
      if (method === 'assistant.review') {
        const snapshot = this.service.adminSnapshot(), draft = snapshot.drafts.find(d => d.owner === params.credentialId && d.conversationId === params.conversationId);
        if (!draft || !snapshot.accountId) throw new ApiError(409, 'draft_missing', 'Draft is unavailable');
        for (const [key, review] of this.reviews) if (review.expiresAt <= this.now()) this.reviews.delete(key);
        if (this.reviews.size >= 32) throw new ApiError(429, 'review_limit', 'Too many pending reviews');
        const reviewId = randomBytes(24).toString('base64url');
        const review = { session, credentialId: draft.owner, conversationId: draft.conversationId, accountId: snapshot.accountId, text: draft.text, draftVersion: draft.version, expiresAt: Math.min(draft.expiresAt, this.now() + 60_000) };
        this.reviews.set(reviewId, review); sendJson(response, 200, { reviewId, ...review, session: undefined }); return 200;
      }
      if (method === 'assistant.send') {
        const reviewId = typeof params.reviewId === 'string' ? params.reviewId : '', review = this.reviews.get(reviewId);
        if (!review || review.session !== session || review.expiresAt <= this.now()) throw new ApiError(403, 'review_expired', 'Review the draft again');
        this.reviews.delete(reviewId); // One use, including an offline or unknown result.
        sendJson(response, 200, await this.service.admin('assistant.send', { ...review, operationId: params.operationId })); return 200;
      }
      if (typeof method !== 'string') throw new ApiError(400, 'invalid_request', 'Setup method required');
      const result = await this.service.admin(method, params);
      this.prune();
      if (method === 'link.start') {
        const link = result as { uri: string; expiresAt: number };
        sendJson(response, 200, { ...link, qr: await QRCode.toDataURL(link.uri, { width: 320, margin: 3, errorCorrectionLevel: 'M' }) });
      } else sendJson(response, 200, result);
      return 200;
    }
    // Android native scope has no CORS or browser exceptions, even on loopback.
    if (request.headers.origin !== undefined) throw new ApiError(403, 'native_only', 'Native Signal API required');
    if (path === '/v1/signal/pair') {
      if (!this.pairingLimiter.allow(request.socket.remoteAddress ?? '')) throw new ApiError(429, 'pairing_failed', 'Pairing failed');
      sendJson(response, 200, this.service.pair(await readJsonBody(request, 1024))); return 200;
    }
    if (path !== '/v1/signal/rpc' && path !== '/v1/signal/mcp') throw new ApiError(404, 'not_found', 'Signal endpoint not found');
    const credential = this.service.authenticate(bearerToken(request));
    const body = await readJsonBody(request, 16_384);
    if (path === '/v1/signal/mcp') {
      const result = await signalMcp(this.service, credential, body);
      if (result === undefined) { response.writeHead(202); response.end(); return 202; }
      sendJson(response, 200, result); return 200;
    }
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(body.id) || typeof body.method !== 'string' || typeof body.params !== 'object' || body.params === null || Array.isArray(body.params)) throw new ApiError(400, 'invalid_request', 'Invalid Signal RPC request');
    try { sendJson(response, 200, { id: body.id, ok: true, result: await this.service.rpc(credential, body.method, body.params as Record<string, unknown>) }); }
    catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Signal request could not complete');
      sendJson(response, safe.status, { id: body.id, ok: false, error: { code: safe.code, message: safe.message } }); return safe.status;
    }
    return 200;
  }
}
