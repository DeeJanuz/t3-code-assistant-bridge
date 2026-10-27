import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const POSIX_ONLY = process.platform === 'win32' && 'Signal service is supported only on macOS and Linux';
import { Script } from 'node:vm';
import { SignalStore } from '../src/signal-store.js';
import { SignalService } from '../src/signal-service.js';
import { SignalHttp } from '../src/signal-http.js';
import { SignalCli, type SignalTransport } from '../src/signal-cli.js';
import { ApiError, sendJson } from '../src/security.js';
import { loadConfig } from '../src/config.js';
import { signalMcp } from '../src/signal-mcp.js';
import { signalSetupHtml } from '../src/signal-setup.js';

const ACCOUNT = '+15550001111', OTHER_ACCOUNT = '+15550002222', AUTHOR = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const SELF = '33333333-3333-4333-8333-333333333333';
class FakeSignal implements SignalTransport {
  ready = true; health = 'ready'; calls: { method: string; params: Record<string, unknown> }[] = [];
  contacts = [{ uuid: AUTHOR, number: '+15550003333', name: 'Synthetic Alice', messageExpirationTime: 0, isBlocked: false },
    { uuid: SECOND, number: '+15550004444', name: 'Synthetic Bob', messageExpirationTime: 0, isBlocked: false }];
  groups = [{ id: 'c3ludGhldGlj', name: 'Synthetic group', isMember: true, isBlocked: false, messageExpirationTime: 0 }];
  onSend: (() => Promise<unknown>) | null = null;
  onContacts: (() => Promise<unknown>) | null = null;
  ownContacts: unknown = [{ uuid: SELF, number: ACCOUNT, messageExpirationTime: 0, isBlocked: false }];
  onOwnContacts: (() => Promise<unknown>) | null = null;
  lateResult: ((value: unknown) => void) | undefined;
  receive: (value: unknown) => void = () => {};
  start(receive: (value: unknown) => void) { this.receive = receive; }
  stop() { this.ready = false; }
  async resetData() { this.stop(); }
  async request(method: string, params: Record<string, unknown> = {}, _timeoutMs?: number, onLateResult?: (value: unknown) => void): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'listContacts') return params.allRecipients ? (this.onOwnContacts ? this.onOwnContacts() : this.ownContacts) : this.onContacts ? this.onContacts() : this.contacts;
    if (method === 'listGroups') return this.groups;
    if (method === 'listAccounts') return [{ number: ACCOUNT }];
    if (method === 'send') { this.lateResult = onLateResult; return this.onSend ? this.onSend() : { timestamp: 1_900_000_000_001, results: [{ type: 'SUCCESS' }] }; }
    return {};
  }
}
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'faceclaw-signal-test-')), store = new SignalStore(path), transport = new FakeSignal();
  let time = 1_900_000_000_000;
  store.state.accountId = ACCOUNT; store.commit();
  const service = new SignalService(store, transport, () => time);
  const pairing = service.createPairing(), paired = service.pair({ code: pairing.code });
  const credential = service.authenticate(paired.token);
  const ingest = (text = 'Synthetic message', extra: Record<string, unknown> = {}, author = AUTHOR, timestamp = time) => service.ingest({
    result: { account: ACCOUNT, envelope: { sourceUuid: author, sourceName: 'Synthetic sender', timestamp,
      dataMessage: { timestamp, message: text, expiresInSeconds: 0, ...extra } } },
  });
  return { path, store, transport, service, credential, paired, ingest, now: () => time, advance: (ms: number) => { time += ms; },
    clean: () => { service.close(); rmSync(path, { recursive: true, force: true }); } };
}

type ConversationView = { id: string; title: string; lastMessageAt?: number };
const directory = async (f: ReturnType<typeof fixture>) =>
  (await f.service.rpc(f.credential, 'conversations', {}) as { conversations: ConversationView[] }).conversations;

test('directory sync, opening a recipient and drafting do not create chat activity', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    const recipients = await f.service.rpc(f.credential, 'recipients', {}) as { recipients: ConversationView[] };
    assert.equal(recipients.recipients.length, 4);
    assert.ok(recipients.recipients.some(c => c.title === 'Note to Self'));
    assert.ok(recipients.recipients.every(c => !Object.hasOwn(c, 'lastMessageAt')));
    const recipientId = recipients.recipients[0]!.id;
    const opened = await f.service.rpc(f.credential, 'conversation.open', { recipientId }) as { conversation: ConversationView };
    assert.equal(opened.conversation.id, recipientId);
    await f.service.rpc(f.credential, 'draft.set', { conversationId: recipientId, text: 'Unsent synthetic draft' });
    const snapshot = await f.service.rpc(f.credential, 'snapshot', {}) as { conversations: ConversationView[] };
    assert.equal(snapshot.conversations.length, 4);
    assert.ok(snapshot.conversations.every(c => !Object.hasOwn(c, 'lastMessageAt')));
  } finally { f.clean(); }
});

test('chat activity orders real incoming and outgoing messages by sent time, independent of arrival and contact refresh', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients();
    const alice = f.store.state.conversations.find(c => c.target === AUTHOR)!.id;
    const bob = f.store.state.conversations.find(c => c.target === SECOND)!.id;
    const group = f.store.state.conversations.find(c => c.kind === 'group')!.id;
    const timestamp = f.now();
    f.ingest('Alice newest', {}, AUTHOR, timestamp);
    f.ingest('Bob older', {}, SECOND, timestamp - 1000);
    f.ingest('Alice delayed', {}, AUTHOR, timestamp - 2000);
    f.ingest('Alice newest duplicate', {}, AUTHOR, timestamp);
    assert.deepEqual((await directory(f)).filter(c => c.lastMessageAt).map(c => [c.id, c.lastMessageAt]), [[alice, timestamp], [bob, timestamp - 1000]]);
    await f.service.refreshRecipients();
    f.advance(1000);
    f.service.ingest({ result: { account: ACCOUNT, envelope: { syncMessage: { sentMessage: {
      destinationUuid: SECOND, timestamp: f.now(), message: 'Synthetic phone reply', expiresInSeconds: 0,
    } } } } });
    assert.equal((await directory(f))[0]?.id, bob);
    assert.equal((await directory(f))[0]?.title, 'Synthetic Bob');
    f.advance(1000);
    f.transport.onSend = async () => ({ timestamp: f.now(), results: [{ type: 'SUCCESS' }] });
    await f.service.rpc(f.credential, 'send', { operationId: 'activity-send', accountId: ACCOUNT, conversationId: group, text: 'Synthetic group reply' });
    await f.service.refreshRecipients();
    assert.deepEqual((await directory(f)).filter(c => c.lastMessageAt).map(c => c.id), [group, bob, alice]);
    const snapshot = await f.service.rpc(f.credential, 'snapshot', {}) as { conversations: ConversationView[] };
    assert.deepEqual(snapshot.conversations, await directory(f));
    const events = await f.service.rpc(f.credential, 'events', { cursor: '0' }) as { events: { type: string; conversation?: ConversationView }[] };
    assert.ok(events.events.some(e => e.type === 'conversation' && e.conversation?.id === group && e.conversation.lastMessageAt === f.now()));
    f.advance(1); f.ingest('Group without repeated metadata', { groupInfo: { groupId: 'c3ludGhldGlj' } });
    assert.equal((await directory(f))[0]?.title, 'Synthetic group');
  } finally { f.clean(); }
});

test('expiry, remote delete and stale replay clear or fall back chat recency without removing the recipient', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    const old = f.now() - 1000;
    f.ingest('Older retained', {}, AUTHOR, old);
    f.ingest('Newest expiring', { expiresInSeconds: 1 });
    const conversationId = f.store.state.conversations[0]!.id;
    const cursor = String(f.store.state.sequence);
    f.advance(1001);
    assert.equal((await directory(f))[0]?.lastMessageAt, old);
    f.ingest('', { remoteDelete: { timestamp: old } });
    f.ingest('Deleted replay', {}, AUTHOR, old);
    const rows = await directory(f);
    assert.equal(rows[0]?.id, conversationId);
    assert.equal(Object.hasOwn(rows[0]!, 'lastMessageAt'), false);
    const events = await f.service.rpc(f.credential, 'events', { cursor }) as { events: { type: string; conversation?: ConversationView }[] };
    const updates = events.events.filter(e => e.type === 'conversation' && e.conversation?.id === conversationId);
    assert.ok(updates.length >= 2);
    assert.ok(updates.every(e => !Object.hasOwn(e.conversation!, 'lastMessageAt')));
    const recipients = await f.service.rpc(f.credential, 'recipients', {}) as { recipients: ConversationView[] };
    assert.ok(recipients.recipients.some(c => c.id === conversationId));
  } finally { f.clean(); }
});

test('activity stays scoped, rejects invalid/account-mismatched events, and survives schema-v1 restart without backfill', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients();
    const allowed = f.store.state.conversations.find(c => c.target === AUTHOR)!.id;
    const denied = f.store.state.conversations.find(c => c.target === SECOND)!.id;
    f.ingest('Allowed activity');
    f.ingest('Private activity', {}, SECOND, f.now() + 1);
    const granted = await f.service.admin('assistant.grant', { conversations: [allowed] }) as { token: string };
    const assistant = f.service.authenticate(granted.token);
    for (const method of ['snapshot', 'conversations']) {
      const result = await f.service.rpc(assistant, method, {}) as { conversations: ConversationView[] };
      assert.deepEqual(result.conversations.map(c => c.id), [allowed]);
      assert.equal(result.conversations[0]?.lastMessageAt, f.now());
    }
    await assert.rejects(f.service.rpc(assistant, 'recipients', {}), /App capability/);
    const events = await f.service.rpc(assistant, 'events', { cursor: '0' }) as { events: { conversation?: ConversationView }[] };
    assert.ok(events.events.every(e => e.conversation?.id !== denied));
    f.service.ingest({ account: OTHER_ACCOUNT, envelope: { sourceUuid: AUTHOR, dataMessage: { message: 'Wrong account', timestamp: f.now() + 10, expiresInSeconds: 0 } } });
    for (const timestamp of [NaN, 0, -1, f.now() + 300_001]) f.ingest('Invalid activity', {}, AUTHOR, timestamp);
    assert.equal((await directory(f)).find(c => c.id === allowed)?.lastMessageAt, f.now());
    const before = await directory(f);
    assert.ok(f.store.state.conversations.every(c => !Object.hasOwn(c, 'lastMessageAt')));
    f.store.close(); const restoredStore = new SignalStore(f.path), restored = new SignalService(restoredStore, new FakeSignal(), f.now);
    try {
      const result = await restored.rpc(restored.authenticate(f.paired.token), 'conversations', {}) as { conversations: ConversationView[] };
      assert.deepEqual(result.conversations, before);
      assert.equal(restoredStore.state.version, 1);
    } finally { restored.close(); }
  } finally { f.clean(); }
});

test('recency sorting has a stable ID tie break and preserves cursor-bound pagination', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 70; i++) f.ingest('Synthetic equal-time message', {}, `+1555${String(i).padStart(7, '0')}`);
    const expected = f.store.state.conversations.map(c => c.id).sort();
    const first = await f.service.rpc(f.credential, 'snapshot', {}) as { conversations: ConversationView[]; cursor: string; nextPage: number };
    assert.equal(first.conversations.length, 64); assert.equal(first.nextPage, 1);
    const second = await f.service.rpc(f.credential, 'snapshot', { page: first.nextPage, snapshotCursor: first.cursor }) as { conversations: ConversationView[]; nextPage: null };
    assert.deepEqual([...first.conversations, ...second.conversations].map(c => c.id), expected);
    assert.equal(second.nextPage, null);
    f.advance(1); f.ingest('New activity');
    await assert.rejects(f.service.rpc(f.credential, 'snapshot', { page: 1, snapshotCursor: first.cursor }), /Snapshot changed/);
  } finally { f.clean(); }
});

test('late confirmed sends add real activity without replay, extending expiry or resurrecting tombstones', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients();
    const conversationId = f.store.state.conversations.find(c => c.target === AUTHOR)!.id;
    f.transport.contacts[0]!.messageExpirationTime = 5;
    f.transport.onSend = async () => { throw new Error('Synthetic timeout'); };
    const params = { accountId: ACCOUNT, conversationId, text: 'Synthetic late send', operationId: 'late-activity' };
    await f.service.rpc(f.credential, 'send', params);
    assert.ok((await directory(f)).every(c => !c.lastMessageAt));
    const sentAt = f.now(), expiresAt = sentAt + 5000;
    f.advance(1000);
    f.transport.lateResult?.({ timestamp: sentAt, results: [{ type: 'SUCCESS' }] });
    assert.equal((await directory(f))[0]?.lastMessageAt, sentAt);
    assert.equal(f.store.state.messages[0]?.expiresAt, expiresAt);
    await f.service.rpc(f.credential, 'send', params);
    assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
    f.advance(4001);
    assert.ok((await directory(f)).every(c => !c.lastMessageAt));
    assert.equal(f.store.state.operations[0]?.status, 'sent');

    await f.service.rpc(f.credential, 'send', { ...params, operationId: 'late-expired' });
    const expiredAt = f.now(); f.advance(5001);
    f.transport.lateResult?.({ timestamp: expiredAt, results: [{ type: 'SUCCESS' }] });
    assert.ok((await directory(f)).every(c => !c.lastMessageAt));
    assert.equal(f.store.state.operations[1]?.status, 'sent');

    await f.service.rpc(f.credential, 'send', { ...params, operationId: 'late-deleted' });
    const deletedAt = f.now();
    f.service.ingest({ account: ACCOUNT, envelope: { syncMessage: { sentMessage: { destinationUuid: AUTHOR,
      timestamp: f.now() + 1, remoteDelete: { timestamp: deletedAt }, expiresInSeconds: 5 } } } });
    f.transport.lateResult?.({ timestamp: deletedAt, results: [{ type: 'SUCCESS' }] });
    assert.ok((await directory(f)).every(c => !c.lastMessageAt));
    assert.equal(f.store.state.messages.length, 0);
  } finally { f.clean(); }
});

test('unconfirmed and future-dated send results cannot create chat activity', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients(); const conversationId = f.store.state.conversations[0]!.id;
    f.transport.onSend = async () => ({ timestamp: f.now() + 300_001, results: [{ type: 'SUCCESS' }] });
    const result = await f.service.rpc(f.credential, 'send', { accountId: ACCOUNT, conversationId, text: 'Synthetic invalid timestamp', operationId: 'future-result' }) as { operation: { status: string } };
    assert.equal(result.operation.status, 'unknown');
    f.transport.lateResult?.({ timestamp: f.now(), results: [{ type: 'SUCCESS' }, { type: 'NETWORK_FAILURE' }] });
    assert.ok((await directory(f)).every(c => !c.lastMessageAt));
    assert.equal(f.store.state.messages.length, 0);
  } finally { f.clean(); }
});

test('Signal config is opt-in, absolute and independent of T3 authentication', { skip: POSIX_ONLY }, () => {
  const base = { BRIDGE_TOKEN: 'a'.repeat(32) };
  assert.equal(loadConfig(base).signal, undefined);
  assert.throws(() => loadConfig({ ...base, BRIDGE_SIGNAL_CLI_PATH: '/bin/false' }));
  assert.throws(() => loadConfig({ ...base, BRIDGE_SIGNAL_CLI_PATH: '/bin/false', BRIDGE_SIGNAL_DATA_DIR: '../data' }));
  assert.deepEqual(loadConfig({ ...base, BRIDGE_SIGNAL_CLI_PATH: '/bin/false', BRIDGE_SIGNAL_DATA_DIR: '/tmp/signal' }).signal,
    { cliPath: '/bin/false', dataDirectory: '/tmp/signal' });
});

test('encrypted store protects content, enforces one writer and survives unknown sends', { skip: POSIX_ONLY }, () => {
  const f = fixture();
  try {
    f.ingest('Private synthetic content');
    assert.equal(readFileSync(join(f.path, 'state.enc')).includes(Buffer.from('Private synthetic content')), false);
    assert.equal(statSync(join(f.path, 'storage.key')).mode & 0o777, 0o600);
    assert.throws(() => new SignalStore(f.path), /already in use/);
    f.store.state.operations.push({ operationId: 'pending-1', conversationId: f.store.state.conversations[0]!.id, status: 'pending', fingerprint: 'hash', owner: f.credential.id, createdAt: f.now() });
    f.store.commit(); f.store.close();
    const restored = new SignalStore(f.path);
    assert.equal(restored.state.operations[0]?.status, 'unknown');
    assert.equal(restored.state.messages[0]?.text, 'Private synthetic content');
    restored.close();
  } finally { f.clean(); }
});

test('encrypted state tampering and insecure permissions fail closed', { skip: POSIX_ONLY }, () => {
  const f = fixture(); f.store.close();
  try {
    const file = join(f.path, 'state.enc'), content = readFileSync(file); content[35] = content[35]! ^ 1; writeFileSync(file, content);
    assert.throws(() => new SignalStore(f.path));
    chmodSync(f.path, 0o755); assert.throws(() => new SignalStore(f.path), /owner-only/);
  } finally { chmodSync(f.path, 0o700); f.clean(); }
});

test('pairing is one use, expires, and never accepts owner/native tokens', { skip: POSIX_ONLY }, () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.authenticate('a'.repeat(32)), /credential/);
    const pair = f.service.createPairing(); f.service.pair({ code: pair.code }); assert.throws(() => f.service.pair({ code: pair.code }));
    const expired = f.service.createPairing(); f.advance(120_001); assert.throws(() => f.service.pair({ code: expired.code }));
  } finally { f.clean(); }
});

test('incoming account isolation, remote deletion, stale replay and drafts expire together', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.service.ingest({ account: OTHER_ACCOUNT, envelope: { sourceUuid: AUTHOR, dataMessage: { message: 'wrong account', timestamp: f.now(), expiresInSeconds: 0 } } });
    assert.equal(f.store.state.messages.length, 0);
    f.ingest(); const message = f.store.state.messages[0]!;
    await f.service.rpc(f.credential, 'draft.set', { conversationId: message.conversationId, text: 'Synthetic reply' });
    f.advance(1); f.ingest('', { remoteDelete: { timestamp: message.timestamp } });
    assert.equal(f.store.state.messages.length, 0); assert.equal(f.store.state.drafts.length, 0);
    f.ingest('Old replay', {}, AUTHOR, message.timestamp); assert.equal(f.store.state.messages.length, 0);
    const events = await f.service.rpc(f.credential, 'events', { cursor: '0' }) as { events: { type: string }[] };
    assert.ok(events.events.some(e => e.type === 'remove')); assert.ok(!events.events.some(e => e.type === 'message'));
  } finally { f.clean(); }
});

test('remote deletion is bound to author and group context', { skip: POSIX_ONLY }, () => {
  const f = fixture();
  try {
    f.ingest('Direct'); const direct = f.store.state.messages[0]!;
    f.ingest('Group', { groupInfo: { groupId: 'c3ludGhldGlj', groupName: 'Synthetic group' } });
    f.advance(1); f.ingest('', { remoteDelete: { timestamp: direct.timestamp } }, SECOND);
    assert.equal(f.store.state.messages.length, 2);
    f.ingest('', { remoteDelete: { timestamp: direct.timestamp }, groupInfo: { groupId: 'c3ludGhldGlj' } });
    assert.equal(f.store.state.messages.length, 1); assert.equal(f.store.state.messages[0]?.text, 'Direct');
  } finally { f.clean(); }
});

test('timed data uses conservative sent timestamp, rejects unknown/view-once, expires offline without read receipts', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.ingest('Unknown', { expiresInSeconds: undefined }); f.ingest('View once', { viewOnce: true });
    assert.equal(f.store.state.messages.length, 0);
    f.ingest('Timed', { expiresInSeconds: 5 }); const msg = f.store.state.messages[0]!;
    assert.equal(msg.expiresAt, f.now() + 5000);
    await f.service.rpc(f.credential, 'draft.set', { conversationId: msg.conversationId, text: 'Timed draft' });
    assert.equal(f.store.state.drafts[0]?.expiresAt, msg.expiresAt);
    f.advance(5001); f.transport.ready = false;
    const snapshot = await f.service.rpc(f.credential, 'snapshot', {}) as { messages: unknown[]; drafts: unknown[] };
    assert.deepEqual(snapshot.messages, []); assert.deepEqual(snapshot.drafts, []);
    assert.equal(f.transport.calls.length, 0);
    f.ingest('Late timed', { expiresInSeconds: 5 }, AUTHOR, f.now() - 10_000); assert.equal(f.store.state.messages.length, 0);
  } finally { f.clean(); }
});

test('send intent is durable before dispatch; duplicates and concurrent requests do not replay', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients(); const conversationId = f.store.state.conversations[0]!.id;
    let resolve!: (value: unknown) => void;
    f.transport.onSend = () => {
      assert.equal(f.store.state.operations[0]?.status, 'pending');
      assert.ok(readFileSync(join(f.path, 'state.enc')).length > 32);
      return new Promise(r => { resolve = r; });
    };
    const params = { operationId: 'send-1', accountId: ACCOUNT, conversationId, text: 'Synthetic send' };
    const first = f.service.rpc(f.credential, 'send', params);
    await Promise.resolve(); await Promise.resolve();
    const duplicate = await f.service.rpc(f.credential, 'send', params) as { operation: { status: string } };
    assert.equal(duplicate.operation.status, 'pending'); assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
    resolve({ timestamp: f.now() + 1, results: [{ type: 'SUCCESS' }] });
    assert.equal((await first as { operation: { status: string } }).operation.status, 'sent');
    assert.equal((await f.service.rpc(f.credential, 'send', params) as { operation: { status: string } }).operation.status, 'sent');
    await assert.rejects(f.service.rpc(f.credential, 'send', { ...params, text: 'Different' }), /already in use/);
    assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
  } finally { f.clean(); }
});

test('offline sends stay drafts; uncertain outcomes never dispatch again', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients(); const conversationId = f.store.state.conversations[0]!.id;
    const params = { operationId: 'send-unknown', accountId: ACCOUNT, conversationId, text: 'Synthetic send' };
    f.transport.ready = false;
    await assert.rejects(f.service.rpc(f.credential, 'send', params), /explicitly send/);
    assert.equal(f.store.state.operations.length, 0);
    f.transport.ready = true; f.transport.onSend = async () => { throw new Error('timeout'); };
    const result = await f.service.rpc(f.credential, 'send', params) as { operation: { status: string } };
    assert.equal(result.operation.status, 'unknown');
    await f.service.rpc(f.credential, 'send', params); assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
  } finally { f.clean(); }
});

test('timed sends refresh timer before dispatch, and missing timer cannot become 30 days', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients(); const conversationId = f.store.state.conversations[0]!.id;
    f.transport.contacts[0]!.messageExpirationTime = 5;
    await f.service.rpc(f.credential, 'send', { operationId: 'timed-send', accountId: ACCOUNT, conversationId, text: 'Timed send' });
    assert.equal(f.store.state.messages[0]?.expiresAt, f.now() + 5000);
    f.transport.onContacts = async () => [{ uuid: AUTHOR }];
    await assert.rejects(f.service.rpc(f.credential, 'send', { operationId: 'bad-timer', accountId: ACCOUNT, conversationId, text: 'No timer' }), /timer/);
    assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
  } finally { f.clean(); }
});

test('Note to Self keeps the linked account direct-chat identity across refresh, sync and restart', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients();
    const self = f.store.state.conversations.find(c => c.self)!;
    assert.equal(self.title, 'Note to Self'); assert.equal(self.target, SELF); assert.equal(self.kind, 'direct');
    const conversationId = self.id;
    f.service.ingest({ result: { account: ACCOUNT, envelope: { syncMessage: { sentMessage: {
      destinationUuid: SELF, timestamp: f.now(), message: 'Synthetic self sync', expiresInSeconds: 0,
    } } } } });
    await f.service.refreshRecipients();
    assert.equal(f.store.state.messages[0]?.conversationId, conversationId);
    assert.equal(f.store.state.conversations.filter(c => c.target === SELF).length, 1);
    assert.equal(self.title, 'Note to Self');
    f.store.close(); const restored = new SignalStore(f.path);
    assert.equal(restored.state.conversations.find(c => c.id === conversationId)?.self, true);
    restored.close();
  } finally { f.clean(); }
});

test('Note to Self uses explicit self-send and its freshly verified real timer without replay', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients(); const self = f.store.state.conversations.find(c => c.self)!;
    f.transport.ownContacts = [{ uuid: SELF, number: ACCOUNT, messageExpirationTime: 5 }];
    const params = { operationId: 'self-send', accountId: ACCOUNT, conversationId: self.id, text: 'Synthetic note' };
    const result = await f.service.rpc(f.credential, 'send', params) as { operation: { status: string } };
    assert.equal(result.operation.status, 'sent');
    assert.deepEqual(f.transport.calls.find(c => c.method === 'send')?.params, { account: ACCOUNT, message: 'Synthetic note', noteToSelf: true });
    assert.equal(f.store.state.messages[0]?.expiresAt, f.now() + 5000);
    assert.deepEqual(f.transport.calls.filter(c => c.method === 'listContacts').at(-1)?.params, { account: ACCOUNT, recipient: [ACCOUNT], allRecipients: true });
    await f.service.rpc(f.credential, 'send', params);
    assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
  } finally { f.clean(); }
});

test('Note to Self fails closed on missing timer, wrong account, changed identity or revoked access', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.transport.ownContacts = [{ uuid: SELF, number: ACCOUNT }];
    await f.service.refreshRecipients(); assert.equal(f.store.state.conversations.some(c => c.self), false);
    f.transport.ownContacts = [{ uuid: SELF, number: ACCOUNT, messageExpirationTime: 0 }];
    await f.service.refreshRecipients(); const self = f.store.state.conversations.find(c => c.self)!;
    const params = { operationId: 'self-denied', accountId: ACCOUNT, conversationId: self.id, text: 'Synthetic note' };
    for (const rows of [[], [{ uuid: SELF, number: ACCOUNT }], [{ uuid: SELF, number: OTHER_ACCOUNT, messageExpirationTime: 0 }],
      [{ uuid: AUTHOR, number: ACCOUNT, messageExpirationTime: 0 }], [{ uuid: SELF, number: ACCOUNT, messageExpirationTime: -1 }]]) {
      f.transport.ownContacts = rows;
      await assert.rejects(f.service.rpc(f.credential, 'send', params), /timer/);
    }
    f.transport.onOwnContacts = async () => {
      await f.service.admin('credential.revoke', { credentialId: f.credential.id });
      return [{ uuid: SELF, number: ACCOUNT, messageExpirationTime: 0 }];
    };
    await assert.rejects(f.service.rpc(f.credential, 'send', params), /revoked/);
    assert.equal(f.store.state.operations.length, 0); assert.equal(f.transport.calls.some(c => c.method === 'send'), false);
  } finally { f.clean(); }
});

test('assistant grants restrict reads/drafts, cannot self-confirm, and revoke during async metadata lookup', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.ingest('Allowed'); f.ingest('Private other conversation', {}, SECOND);
    const allowed = f.store.state.conversations[0]!.id, denied = f.store.state.conversations[1]!.id;
    const granted = await f.service.admin('assistant.grant', { conversations: [allowed] }) as { token: string; credentialId: string };
    const assistant = f.service.authenticate(granted.token);
    const snapshot = await f.service.rpc(assistant, 'snapshot', {}) as { messages: { text: string }[] };
    assert.deepEqual(snapshot.messages.map(m => m.text), ['Allowed']);
    await assert.rejects(f.service.rpc(assistant, 'history', { conversationId: denied }), /not enabled/);
    await assert.rejects(f.service.rpc(assistant, 'send', { conversationId: allowed, text: 'claimed approval', confirmation: true }), /reviewed/);
    await f.service.rpc(assistant, 'draft.set', { conversationId: allowed, text: 'Reviewed draft' });
    let release!: (value: unknown) => void;
    f.transport.onContacts = () => new Promise(r => { release = r; });
    const send = f.service.admin('assistant.send', { credentialId: granted.credentialId, conversationId: allowed, accountId: ACCOUNT, operationId: 'approved-1', text: 'Reviewed draft', expiresAt: f.now() + 60_000, draftVersion: f.store.state.drafts[0]!.version });
    await f.service.admin('credential.revoke', { credentialId: granted.credentialId });
    release(f.transport.contacts);
    await assert.rejects(send, /revoked/);
    assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 0);
    assert.throws(() => f.service.authenticate(granted.token), /revoked/);
    assert.equal(f.store.state.drafts.length, 0); assert.ok(f.service.authenticate(f.paired.token));
  } finally { f.clean(); }
});

test('snapshot pages are bounded, mutation rejects stale pages and settings force reconciliation', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 70; i++) f.ingest('Synthetic ' + i, {}, AUTHOR, f.now() + i);
    const first = await f.service.rpc(f.credential, 'snapshot', {}) as { messages: unknown[]; cursor: string; nextPage: number };
    assert.equal(first.messages.length, 64); assert.equal(first.nextPage, 1);
    const last = await f.service.rpc(f.credential, 'snapshot', { page: 1, snapshotCursor: first.cursor }) as { messages: unknown[]; nextPage: null };
    assert.equal(last.messages.length, 6); assert.equal(last.nextPage, null);
    f.ingest('New event', {}, AUTHOR, f.now() + 100);
    await assert.rejects(f.service.rpc(f.credential, 'snapshot', { page: 1, snapshotCursor: first.cursor }), /Snapshot changed/);
    await f.service.admin('settings', { retentionDays: 2, preview: 'sender' });
    const events = await f.service.rpc(f.credential, 'events', { cursor: first.cursor }) as { reset: boolean; preview: string; retentionDays: number };
    assert.equal(events.reset, true); assert.equal(events.preview, 'sender'); assert.equal(events.retentionDays, 2);
  } finally { f.clean(); }
});

test('assistant approval cannot survive changing and restoring the exact draft during timer lookup', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.ingest(); const conversationId = f.store.state.conversations[0]!.id;
    const grant = await f.service.admin('assistant.grant', { conversations: [conversationId] }) as { token: string; credentialId: string };
    const assistant = f.service.authenticate(grant.token);
    await f.service.rpc(assistant, 'draft.set', { conversationId, text: 'Exact text' });
    const draftVersion = f.store.state.drafts[0]!.version;
    let release!: (value: unknown) => void;
    f.transport.onContacts = () => new Promise(resolve => { release = resolve; });
    const sending = f.service.admin('assistant.send', { credentialId: grant.credentialId, conversationId, accountId: ACCOUNT, operationId: 'draft-race', text: 'Exact text', expiresAt: f.now() + 60_000, draftVersion });
    await f.service.rpc(assistant, 'draft.set', { conversationId, text: 'Changed' });
    await f.service.rpc(assistant, 'draft.set', { conversationId, text: 'Exact text' });
    release(f.transport.contacts);
    await assert.rejects(sending, /Draft changed/);
    assert.equal(f.store.state.operations.length, 0); assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 0);
  } finally { f.clean(); }
});

test('HTTP boundaries isolate APK, assistant, owner and browser origins; setup requires one-use review', { skip: POSIX_ONLY }, async () => {
  const f = fixture(), ownerToken = 'o'.repeat(32), http = new SignalHttp(f.service, ownerToken, f.now);
  const server = createServer((request, response) => {
    void http.handle(request, response, new URL(request.url ?? '/', 'http://bridge.invalid')).catch(error => {
      const safe = error instanceof ApiError ? error : new ApiError(500, 'internal', 'Internal error');
      sendJson(response, safe.status, { error: { code: safe.code, message: safe.message } });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token?: string, origin?: string) => fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}),
  }, body: JSON.stringify(body) });
  try {
    const body = { id: '1', method: 'status', params: {} };
    assert.equal((await post('/v1/signal/rpc', body, ownerToken)).status, 401);
    assert.equal((await post('/v1/signal/rpc', body, f.paired.token, base)).status, 403);
    assert.equal((await post('/v1/signal/rpc', body, f.paired.token)).status, 200);
    assert.equal((await post('/v1/signal/admin', { method: 'status' }, f.paired.token, base)).status, 401);
    assert.equal((await post('/v1/signal/admin', { method: 'login', params: { ownerToken } }, undefined, 'https://attacker.invalid')).status, 403);
    const login = await post('/v1/signal/admin', { method: 'login', params: { ownerToken } }, undefined, base);
    const session = (await login.json() as { token: string }).token;
    assert.equal((await post('/v1/signal/rpc', body, session)).status, 401);
    assert.equal((await post('/v1/signal/admin', { method: 'assistant.send', params: { reviewId: 'model-claimed-approval', operationId: 'op' } }, session, base)).status, 403);
    const page = await fetch(base + '/signal/setup'); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + '/signal/setup', { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(badHost, 403);
    f.ingest(); const conversationId = f.store.state.conversations[0]!.id;
    const grant = await f.service.admin('assistant.grant', { conversations: [conversationId] }) as { token: string; credentialId: string };
    await f.service.rpc(f.service.authenticate(grant.token), 'draft.set', { conversationId, text: 'Exact reviewed text' });
    const review = await post('/v1/signal/admin', { method: 'assistant.review', params: { credentialId: grant.credentialId, conversationId } }, session, base);
    const reviewId = (await review.json() as { reviewId: string }).reviewId;
    const sendBody = { method: 'assistant.send', params: { reviewId, operationId: 'exact-1', text: 'tampered text ignored' } };
    assert.equal((await post('/v1/signal/admin', sendBody, session, base)).status, 200);
    assert.equal(f.transport.calls.find(c => c.method === 'send')?.params.message, 'Exact reviewed text');
    assert.equal((await post('/v1/signal/admin', sendBody, session, base)).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.clean(); }
});

test('local reset revokes independently and removes integration content before resetting CLI', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.ingest();
    await assert.rejects(f.service.admin('account.reset', { confirm: 'yes', accountId: ACCOUNT }), /Confirm deletion/);
    await f.service.admin('account.reset', { confirm: 'DELETE LOCAL SIGNAL DATA', accountId: ACCOUNT });
    assert.equal(f.store.state.accountId, null); assert.equal(f.store.state.messages.length, 0); assert.equal(f.store.state.credentials.length, 0);
    assert.throws(() => f.service.authenticate(f.paired.token));
  } finally { f.clean(); }
});

test('partial group results stay unknown; only an exact late successful result reconciles', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    await f.service.refreshRecipients(); const conversationId = f.store.state.conversations.find(c => c.kind === 'group')!.id;
    f.transport.onSend = async () => ({ timestamp: f.now(), results: [{ type: 'SUCCESS' }, { type: 'NETWORK_FAILURE' }] });
    const params = { accountId: ACCOUNT, conversationId, text: 'Partial synthetic group send', operationId: 'partial-1' };
    assert.equal((await f.service.rpc(f.credential, 'send', params) as { operation: { status: string } }).operation.status, 'unknown');
    f.transport.lateResult?.({ timestamp: f.now(), results: [{ type: 'SUCCESS' }] });
    assert.equal(f.store.state.operations[0]?.status, 'sent');
    await f.service.rpc(f.credential, 'send', params); assert.equal(f.transport.calls.filter(c => c.method === 'send').length, 1);
  } finally { f.clean(); }
});

test('MCP exposes only scoped reads and drafts; no send or arbitrary backend method', { skip: POSIX_ONLY }, async () => {
  const f = fixture();
  try {
    f.ingest(); const conversationId = f.store.state.conversations[0]!.id;
    const grant = await f.service.admin('assistant.grant', { conversations: [conversationId] }) as { token: string };
    const assistant = f.service.authenticate(grant.token);
    await assert.rejects(signalMcp(f.service, f.credential, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /assistant credential/);
    const listed = await signalMcp(f.service, assistant, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    assert.deepEqual(listed.result.tools.map(t => t.name), ['signal_status', 'signal_conversations', 'signal_history', 'signal_draft']);
    await signalMcp(f.service, assistant, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'signal_draft', arguments: { conversationId, text: 'MCP synthetic draft' } } });
    assert.equal(f.store.state.drafts[0]?.text, 'MCP synthetic draft'); assert.equal(f.transport.calls.length, 0);
    await assert.rejects(signalMcp(f.service, assistant, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send', arguments: {} } }), /Unknown Signal tool/);
    await assert.rejects(signalMcp(f.service, assistant, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'signal_draft', arguments: { conversationId, text: 'x', approved: true } } }), /Unsupported/);
    await f.service.admin('credential.revoke', { credentialId: assistant.id });
    assert.throws(() => f.service.authenticate(grant.token));
  } finally { f.clean(); }
});

test('dashboard script parses and keeps unsafe profile data out of HTML generation', { skip: POSIX_ONLY }, () => {
  const html = signalSetupHtml('synthetic-nonce');
  const script = /<script nonce="synthetic-nonce">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script); new Script(script);
  assert.equal(script.includes('innerHTML'), false);
  assert.ok(script.includes('settingsDirty')); assert.ok(script.includes('activeReview'));
});

test('supervised CLI verifies version, subscribes and scopes private process options using a synthetic executable', { skip: POSIX_ONLY }, async () => {
  const path = mkdtempSync(join(tmpdir(), 'faceclaw-signal-child-'));
  const executable = join(path, 'fixture-cli');
  writeFileSync(executable, `#!${process.execPath}\nconst readline=require('node:readline');const args=process.argv.slice(2);if(!args.includes('--disable-send-log')||!args.includes('--ignore-attachments')||args.includes('--send-read-receipts'))process.exit(2);readline.createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);const result=v.method==='version'?{version:'0.14.7'}:v.method==='listAccounts'?[{number:'+15550001111'}]:0;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:v.id,result})+'\\n');});`, { mode: 0o700 });
  const cli = new SignalCli(executable, join(path, 'account'));
  try {
    cli.start(() => {});
    const until = Date.now() + 5000;
    while (!cli.ready && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cli.ready, true);
    assert.deepEqual(await cli.request('listAccounts'), [{ number: ACCOUNT }]);
    await cli.resetData(); assert.equal(cli.ready, false);
  } finally { cli.stop(); rmSync(path, { recursive: true, force: true }); }
});

test('full bridge routes loopback Signal setup before rejecting browser origins elsewhere', { skip: POSIX_ONLY }, async () => {
  const { createBridgeServer } = await import('../src/server.js');
  const directory = mkdtempSync(join(tmpdir(), 'faceclaw-signal-server-'));
  const ownerToken = 'o'.repeat(32);
  const config = { ...loadConfig({ BRIDGE_TOKEN: ownerToken, BRIDGE_PASSPHRASE: 'pair-secret', BRIDGE_POLL_INTERVAL_MS: '60000' }),
    signal: { cliPath: join(directory, 'missing-signal-cli'), dataDirectory: join(directory, 'data') } };
  const client = { shell: async () => ({ snapshotSequence: 1, projects: [], threads: [] }) } as never;
  const server = createBridgeServer(config, client, { transcribe: async () => '' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, origin?: string) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/signal/setup')).status, 200);
    assert.equal((await post('/v1/signal/admin', { method: 'login', params: { ownerToken } }, base)).status, 200);
    assert.equal((await post('/v1/signal/admin', { method: 'login', params: { ownerToken } }, 'https://attacker.invalid')).status, 403);
    assert.equal((await post('/v1/faceclaw/pair', { passphrase: 'pair-secret' }, base)).status, 403);
    assert.equal((await post('/v1/faceclaw/pair', { passphrase: 'pair-secret' })).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
