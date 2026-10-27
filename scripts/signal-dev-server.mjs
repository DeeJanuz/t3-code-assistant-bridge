// Synthetic local dashboard/API fixture. Never reads installed configuration,
// starts signal-cli, links an account, contacts Signal, or sends real messages.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalStore } from '../bridge/dist/src/signal-store.js';
import { SignalService } from '../bridge/dist/src/signal-service.js';
import { SignalHttp } from '../bridge/dist/src/signal-http.js';
import { ApiError, sendJson } from '../bridge/dist/src/security.js';

export const FIXTURE_OWNER = 'fixture-signal-owner-token-for-local-tests-only';
const account = '+15550001111', alice = '11111111-1111-4111-8111-111111111111', bob = '22222222-2222-4222-8222-222222222222';
const directory = mkdtempSync(join(tmpdir(), 'faceclaw-signal-dashboard-'));
const store = new SignalStore(directory); store.state.accountId = account; store.commit();
const transport = {
  ready: true, health: 'ready', start() {}, stop() { this.ready = false; }, async resetData() { this.stop(); },
  async request(method) {
    if (method === 'listContacts') return [{ uuid: alice, name: 'Alex Example', messageExpirationTime: 0 }, { uuid: bob, name: 'Morgan Example', messageExpirationTime: 0 }];
    if (method === 'listGroups') return [{ id: 'c3ludGhldGljLWdyb3Vw', name: 'Weekend plans', isMember: true, isBlocked: false, messageExpirationTime: 0 }];
    if (method === 'send') return { timestamp: Date.now(), results: [{ type: 'SUCCESS' }] };
    if (method === 'listAccounts') return [{ number: account }];
    return {};
  },
};
const service = new SignalService(store, transport);
await service.refreshRecipients();
for (const [author, name, text, delta] of [[alice, 'Alex Example', 'Can we meet at the trailhead at 9?', 2000], [bob, 'Morgan Example', 'I will bring snacks for the hike.', 1000]]) {
  const timestamp = Date.now() - delta;
  service.ingest({ result: { account, envelope: { sourceUuid: author, sourceName: name, timestamp, dataMessage: { timestamp, expiresInSeconds: 0, message: text } } } });
}
const conversationId = store.state.conversations[0].id;
const assistant = await service.admin('assistant.grant', { conversations: [conversationId] });
await service.rpc(service.authenticate(assistant.token), 'draft.set', { conversationId, text: 'Yes, 9 works for me. See you at the trailhead.' });
const api = new SignalHttp(service, FIXTURE_OWNER);
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  void api.handle(request, response, new URL(request.url ?? '/', 'http://bridge.invalid')).then(status => {
    if (status === null) sendJson(response, 404, { error: { message: 'Not found' } });
  }).catch(error => {
    const safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Fixture request failed');
    sendJson(response, safe.status, { error: { code: safe.code, message: safe.message } });
  });
});
server.listen(18791, '127.0.0.1', () => { api.start(); process.stdout.write('Synthetic Signal setup: http://127.0.0.1:18791/signal/setup\n'); });
let closed = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (closed) return; closed = true;
  server.close(() => { api.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); });
});
