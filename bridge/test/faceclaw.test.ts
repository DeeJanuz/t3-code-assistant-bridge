import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { FaceclawRelay, faceclawToken, mintToolToken, verifyToolToken } from '../src/faceclaw.js';
import type { T3Client, Transcriber } from '../src/types.js';

const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const tool = { name: 'display_text', description: 'Display text', inputSchema: { type: 'object' } };
test('tool capabilities bind project/thread/expiry and reject tampering, master/native credentials', () => {
  const binding = { projectId: 'assistant', threadId: 'thread-1', expiresAt: Date.now() + 60_000 };
  const token = mintToolToken(secret, binding);
  assert.deepEqual(verifyToolToken(secret, token, 'assistant'), binding);
  for (const bad of [secret, faceclawToken(secret), `${token}x`, undefined]) assert.throws(() => verifyToolToken(secret, bad, 'assistant'));
  assert.throws(() => verifyToolToken(secret, token, 'other'));
  assert.throws(() => verifyToolToken('different-process-key', token, 'assistant'));
  assert.throws(() => verifyToolToken(secret, token, 'assistant', binding.expiresAt));
});

test('tool relay authenticates result peer, prevents replay, and never queues disconnected actions', async () => {
  const relay = new FaceclawRelay('assistant');
  const peer = {}, other = {};
  const sent: Record<string, unknown>[] = [];
  assert.throws(() => relay.register(peer, { projectId: 'other', tools: [tool] }, () => {}));
  relay.register(peer, { projectId: 'assistant', tools: [tool] }, value => sent.push(value as Record<string, unknown>));
  assert.throws(() => relay.register(other, { projectId: 'assistant', tools: [tool] }, () => {}));
  const binding = { projectId: 'assistant', threadId: 'thread-1', expiresAt: Date.now() + 60_000 };
  const call = relay.call(binding, 'call-1', { name: tool.name, arguments: { text: 'hello' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.threadId, binding.threadId);
  assert.throws(() => relay.result(other, { callId: sent[0]?.callId, result: { content: [] } }));
  relay.result(peer, { callId: sent[0]?.callId, result: { content: [{ type: 'text', text: 'done' }] } });
  assert.deepEqual(await call, { content: [{ type: 'text', text: 'done' }] });
  await assert.rejects(relay.call(binding, 'call-1', { name: tool.name, arguments: {} }), /already dispatched/);
  assert.throws(() => relay.result(peer, { callId: sent[0]?.callId, result: { content: [] } }));
  const pending = relay.call(binding, 'call-2', { name: tool.name, arguments: {} });
  relay.disconnect(peer);
  await assert.rejects(pending, /Connection dropped/);
  await assert.rejects(relay.call(binding, 'call-3', { name: tool.name, arguments: {} }), /disconnected/);
  relay.register(other, { projectId: 'assistant', tools: [tool] }, value => sent.push(value as Record<string, unknown>));
  await assert.rejects(relay.call(binding, 'call-2', { name: tool.name, arguments: {} }), /already dispatched/);
  assert.equal(sent.length, 2);
});

test('generic capability catalogs require protocol v1 and increasing revisions on one connection', () => {
  const relay = new FaceclawRelay('assistant'); const peer = {};
  const metadata = { 'org.faceclaw/capability': { protocolVersion: 1, provider: 'com.example/.Service', profiles: [{ id: 'org.faceclaw.profile.echo', version: 1 }] } };
  const params = { protocolVersion: 1, catalogRevision: 1, projectId: 'assistant', tools: [{ ...tool, _meta: metadata }] };
  assert.throws(() => relay.register(peer, { projectId: 'assistant', tools: [tool] }, () => {}, true), /protocol/);
  relay.register(peer, params, () => {}, true);
  assert.deepEqual(relay.list().tools[0]?._meta, metadata);
  assert.throws(() => relay.register(peer, params, () => {}, true), /revision/);
  assert.deepEqual(relay.register(peer, { ...params, catalogRevision: 2 }, () => {}, true), { registered: true });
  assert.throws(() => relay.register(peer, { ...params, protocolVersion: 2, catalogRevision: 3 }, () => {}, true), /protocol/);
});

test('relay rejects arguments outside the registered capability schema before dispatch', async () => {
  const relay = new FaceclawRelay('assistant'); const peer = {}, sent: unknown[] = [];
  relay.register(peer, { protocolVersion: 1, catalogRevision: 1, projectId: 'assistant', tools: [{ ...tool,
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 20 } }, required: ['query'], additionalProperties: false },
  }] }, value => sent.push(value));
  const binding = { projectId: 'assistant', threadId: 'thread-1', expiresAt: Date.now() + 60_000 };
  await assert.rejects(relay.call(binding, 'invalid-1', { name: tool.name, arguments: { query: '', extra: true } }), /Invalid tool call/);
  assert.equal(sent.length, 0);
});

test('Faceclaw native pairing and socket keep owner credential separation and existing T3 APIs', async () => {
  const origin = 'https://hub.example';
  const config = loadConfig({ BRIDGE_TOKEN: secret, BRIDGE_PASSPHRASE: 'pair-secret', BRIDGE_POLL_INTERVAL_MS: '60000' });
  const client = { shell: async () => ({ snapshotSequence: 1, projects: [], threads: [] }) } as unknown as T3Client;
  const server = createBridgeServer(config, client, {} as Transcriber);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token?: string, requestOrigin?: string) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(body),
  });
  let socket: WebSocket | undefined;
  try {
    assert.equal((await post('/v1/faceclaw/pair', { passphrase: 'pair-secret' }, undefined, origin)).status, 403);
    assert.equal((await post('/v1/faceclaw/pair', { passphrase: 'wrong' })).status, 401);
    const response = await post('/v1/faceclaw/pair', { passphrase: 'pair-secret' });
    assert.equal(response.status, 200);
    const native = (await response.json() as { token: string }).token;
    assert.notEqual(native, secret);
    assert.equal((await post('/v1/faceclaw/tool-credential', { threadId: 'x' }, native)).status, 401);
    assert.equal((await fetch(base + '/v1/status', { headers: { Authorization: `Bearer ${native}` } })).status, 401);
    for (const [path, token, requestOrigin] of [
      ['/v1/events', native, undefined], ['/v1/faceclaw/events', secret, undefined], ['/v1/faceclaw/events', native, origin],
    ] as const) {
      const denied = new WebSocket(base.replace('http:', 'ws:') + path, ['even-t3-v1', `auth.${token}`], requestOrigin ? { origin: requestOrigin } : {});
      await assert.rejects(once(denied, 'open'), /401/);
    }
    socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/faceclaw/events', ['even-t3-v1', `auth.${native}`]);
    await once(socket, 'open');
    const rpc = (method: string, params = {}) => new Promise<Record<string, unknown>>(resolve => {
      const id = Math.random().toString(36).slice(2);
      const receive = (data: WebSocket.RawData) => { const value = JSON.parse(data.toString()); if (value.id === id) { socket!.off('message', receive); resolve(value); } };
      socket!.on('message', receive); socket!.send(JSON.stringify({ v: 1, type: 'request', id, method, params }));
    });
    assert.deepEqual((await rpc('projects.list')).result, { snapshotId: '1', projects: [] });
    assert.equal((await rpc('refinement.rewrite', { text: 'hello', instruction: 'Fix spelling' })).ok, false);
    assert.deepEqual((await rpc('refinement.cancel')).result, { cancelled: false });
  } finally { socket?.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
