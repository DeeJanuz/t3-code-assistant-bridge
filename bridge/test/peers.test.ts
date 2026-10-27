import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { ManagedEnvironmentRouter } from '../src/environment-router.js';
import { peerOperation } from '../src/peer-operations.js';
import { PeerStore, peerSecret, peerHash, peerOrigin, type PeerEntry, type PeerIdentity } from '../src/peer-store.js';
import { PeerT3Client, PEER_PROTOCOL, PEER_PATH } from '../src/peer-client.js';
import type { BridgeConfig, T3Client, T3Thread, T3ShellSnapshot } from '../src/types.js';

const at = '2026-09-13T00:00:00.000Z';
function fixture(environmentId: string) {
  const calls: { method: string; input: unknown }[] = [];
  const thread: T3Thread = { id: 'shared-thread', projectId: 'shared-project', title: environmentId,
    modelSelection: { instanceId: 'provider', model: 'model' }, runtimeMode: 'approval-required',
    interactionMode: 'default', createdAt: at, updatedAt: at, archivedAt: null,
    settledOverride: null, settledAt: null, latestTurn: null, session: null, messages: [] };
  const shell: T3ShellSnapshot = { snapshotSequence: 1, updatedAt: at,
    projects: [{ id: 'shared-project', title: environmentId, defaultModelSelection: null, createdAt: at, updatedAt: at }], threads: [thread] };
  const action = (method: string) => async (input: unknown) => { calls.push({ method, input }); return { sequence: 2 }; };
  const client: T3Client = {
    descriptor: async () => ({ environmentId, label: environmentId, serverVersion: 'test', capabilities: { threadSettlement: true } }),
    shell: async () => shell, thread: async () => ({ snapshotSequence: 1, thread }),
    threadPage: async () => ({ snapshotSequence: 1, thread }), modelCatalog: async () => ({ providers: [] }),
    startSession: action('startSession'), sendMessage: action('sendMessage'), steerMessage: action('steerMessage'), replyMessage: action('replyMessage'),
    settleThread: action('settleThread'), respondToPlanInput: action('respondToPlanInput'),
    setModel: action('setModel'), setReasoning: action('setReasoning'), approvePlan: action('approvePlan'),
  };
  const config = loadConfig({ BRIDGE_TOKEN: 'x'.repeat(32) });
  return { client, thread, shell, calls, config };
}
async function eventually(check: () => Promise<boolean>, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Condition did not become true');
}

describe('peer authorization and operations', () => {
  it('filters local project restrictions and rejects snapshots, foreign IDs, and arbitrary dispatch', async () => {
    const f = fixture('owner');
    const denied = { ...f.config, projectIds: new Set(['other']) };
    assert.deepEqual((await peerOperation(f.client, denied, 'shell', {}) as T3ShellSnapshot).threads, []);
    for (const [method, params] of [
      ['sendMessage', { threadId: 'shared-thread', text: 'hello', thread: f.thread }],
      ['dispatch', { type: 'thread.turn.start' }], ['thread', { threadId: 'foreign' }],
      ['startSession', { projectId: 'shared-project', threadId: 'new', text: 'hello', runtimeMode: 'auto' }],
    ] as const) await assert.rejects(peerOperation(f.client, f.config, method, params));
    await assert.rejects(peerOperation(f.client, denied, 'sendMessage', { threadId: 'shared-thread', text: 'hello' }));
    assert.equal(f.calls.length, 0);
  });
  it('revalidates every mutation and preserves local runtime state and supplied command IDs', async () => {
    const f = fixture('owner');
    await peerOperation(f.client, f.config, 'startSession', { projectId: 'shared-project', threadId: 'new', text: 'hello' });
    assert.equal((f.calls[0]!.input as { runtimeMode: string }).runtimeMode, 'full-access');
    await peerOperation(f.client, f.config, 'sendMessage', { threadId: 'shared-thread', text: 'hello' });
    assert.equal((f.calls[1]!.input as { thread: T3Thread }).thread.runtimeMode, 'approval-required');
    await peerOperation(f.client, f.config, 'setModel', { threadId: 'shared-thread', selection: { instanceId: 'provider', model: 'new' }, expectedModel: { instanceId: 'provider', model: 'model' } });
    await peerOperation(f.client, f.config, 'setReasoning', { threadId: 'shared-thread', reasoningId: 'high', expectedModel: { instanceId: 'provider', model: 'model' } });
    await peerOperation(f.client, f.config, 'settleThread', { threadId: 'shared-thread' });
    await assert.rejects(peerOperation(f.client, f.config, 'setReasoning', { threadId: 'shared-thread', reasoningId: 'high', expectedModel: { instanceId: 'provider', model: 'stale' } }));
    Object.assign(f.thread, { interactionMode: 'plan', latestTurn: { turnId: 'turn', state: 'completed', requestedAt: at, startedAt: at, completedAt: at },
      proposedPlans: [{ id: 'plan', turnId: 'turn', planMarkdown: 'Reviewed plan', createdAt: at, updatedAt: at, implementedAt: null, implementationThreadId: null }] });
    await peerOperation(f.client, f.config, 'approvePlan', { threadId: 'shared-thread', planId: 'plan', planMarkdown: 'Reviewed plan', commandId: 'stable-command' });
    assert.equal((f.calls.at(-1)!.input as { commandId: string }).commandId, 'stable-command');
    await assert.rejects(peerOperation(f.client, f.config, 'approvePlan', { threadId: 'shared-thread', planId: 'plan', planMarkdown: 'Unreviewed', commandId: 'stable-command' }));
    Object.assign(f.thread, { latestTurn: { turnId: 'turn', state: 'running', requestedAt: at, startedAt: at, completedAt: null },
      session: { status: 'running', activeTurnId: 'turn', updatedAt: at } });
    await assert.rejects(peerOperation(f.client, f.config, 'sendMessage', { threadId: 'shared-thread', text: 'hello' }));
    await peerOperation(f.client, f.config, 'steerMessage', { threadId: 'shared-thread', text: 'steering' });
    Object.assign(f.thread, { hasPendingUserInput: true, activities: [{ kind: 'user-input.requested', turnId: 'turn', createdAt: at,
      payload: { requestId: 'question', questions: [{ id: 'q', header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }], multiSelect: false }] } }] });
    await peerOperation(f.client, f.config, 'respondToPlanInput', { threadId: 'shared-thread', requestId: 'question', commandId: 'stable-answer', answers: { q: 'One' } });
    assert.equal((f.calls.at(-1)!.input as { commandId: string }).commandId, 'stable-answer');
    await assert.rejects(peerOperation(f.client, f.config, 'respondToPlanInput', { threadId: 'shared-thread', requestId: 'question', commandId: 'stable-answer', answers: { other: 'bad' } }));
  });
  it('validates origin, invitation expiry, exact replay, identity collisions, and owner-only storage', { skip: process.platform === 'win32' && 'Peer federation is supported only on macOS and Linux' }, async () => {
    for (const origin of ['http://host.tail.ts.net', 'https://evil.example', 'https://host.tail.ts.net/path', 'https://user@host.tail.ts.net', 'https://host.tail.ts.net/?token=bad']) assert.throws(() => peerOrigin(origin));
    const dir = await mkdtemp(join(tmpdir(), 'peer-store-'));
    const store = new PeerStore(dir);
    try {
      await store.initialize({ environmentId: 'owner', label: 'Owner', origin: 'https://owner.tail.ts.net' });
      const invite = await store.invite(), remote = { bridgeId: 'remote-bridge', environmentId: 'remote', label: 'Remote', origin: 'https://remote.tail.ts.net' };
      const request = { version: 1, identity: remote, id: invite.id, secret: invite.secret, token: peerSecret() };
      const result = await store.accept(request);
      assert.deepEqual(await store.accept(request), result);
      assert.equal((await store.read()).peers.length, 1);
      assert.equal(await store.authorize(result.token), undefined);
      await assert.rejects(store.accept({ ...request, token: peerSecret() }));
      await store.confirm(result.token);
      assert.equal((await store.authorize(result.token))?.bridgeId, remote.bridgeId);
      const expired = await store.invite();
      await store.update(s => { s.invitations[expired.id]!.expiresAt = 0; });
      await assert.rejects(store.accept({ ...request, id: expired.id, secret: expired.secret }));
      await store.revoke(remote.bridgeId);
      assert.equal(await store.authorize(result.token), undefined);
      await assert.rejects(store.accept(request));
      if (process.platform !== 'win32') {
        assert.equal((await stat(store.file)).mode & 0o777, 0o600);
        await chmod(store.file, 0o644); await assert.rejects(store.read());
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('three-host peer federation', () => {
  it('falls back once for an older peer that does not support atomic replies', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const remote = { bridgeId: 'remote', environmentId: 'remote-env', label: 'Remote', origin: 'https://remote.tail.ts.net', incomingHash: peerHash(peerSecret()), outgoingToken: peerSecret(), state: 'paired' as const, transactionId: 'test' };
    const local = { bridgeId: 'local', environmentId: 'local-env', label: 'Local', origin: 'https://local.tail.ts.net' };
    const f = fixture('remote-env'), methods: string[] = [];
    server.on('connection', socket => socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      methods.push(request.method);
      if (request.method === 'replyMessage') {
        socket.send(JSON.stringify({ v: 1, id: request.id, ok: false, error: { code: 'method_not_found' } }));
        return;
      }
      if (request.method === 'steerMessage') {
        socket.send(JSON.stringify({ v: 1, id: request.id, ok: false, error: { code: 'session_not_running' } }));
        return;
      }
      const result = request.method === 'hello' ? { version: 1, ...remote }
        : request.method === 'shell' ? f.shell : { sequence: 2 };
      socket.send(JSON.stringify({ v: 1, id: request.id, ok: true, result }));
    }));
    const client = new PeerT3Client(remote, local, 65536,
      (_url, options) => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, PEER_PROTOCOL, options));
    try {
      assert.deepEqual(await client.replyMessage({ thread: f.thread, text: 'legacy reply' }), { sequence: 2 });
      const active = { ...f.thread, latestTurn: { turnId: 'turn', state: 'running', requestedAt: at, startedAt: at, completedAt: null },
        session: { status: 'running', activeTurnId: 'turn', updatedAt: at } } as T3Thread;
      assert.deepEqual(await client.replyMessage({ thread: active, text: 'changed while sending' }), { sequence: 2 });
      assert.equal(methods.filter(method => method === 'replyMessage').length, 2);
      assert.equal(methods.filter(method => method === 'sendMessage').length, 2);
      assert.equal(methods.filter(method => method === 'steerMessage').length, 1);
    } finally {
      client.close(); server.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('does not replay an accepted mutation after disconnect and rejects incompatible handshakes', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const remote = { bridgeId: 'remote', environmentId: 'remote-env', label: 'Remote', origin: 'https://remote.tail.ts.net', incomingHash: peerHash(peerSecret()), outgoingToken: peerSecret(), state: 'paired' as const, transactionId: 'test' };
    const local = { bridgeId: 'local', environmentId: 'local-env', label: 'Local', origin: 'https://local.tail.ts.net' };
    let accepted = 0, version = 1;
    server.on('connection', socket => socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'sendMessage') { accepted++; socket.close(); return; }
      socket.send(JSON.stringify({ v: 1, id: request.id, ok: true, result: request.method === 'hello'
        ? { version, ...remote } : { environmentId: remote.environmentId, label: remote.label, capabilities: { threadSettlement: true } } }));
    }));
    const make = () => new PeerT3Client(remote, local, 65536, (_url, options) => new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, PEER_PROTOCOL, options));
    const client = make(); let incompatible: PeerT3Client | undefined;
    try {
      await assert.rejects(client.sendMessage({ thread: fixture('owner').thread, text: 'once' }), { code: 'peer_operation_uncertain' });
      assert.equal(accepted, 1);
      await eventually(async () => { try { await client.descriptor(); return true; } catch { return false; } }, 7000);
      assert.equal(accepted, 1);
      version = 2; incompatible = make();
      await assert.rejects(incompatible.descriptor());
    } finally {
      client.close(); incompatible?.close();
      server.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('aggregates each owner once, routes duplicate IDs, isolates credentials, and revokes active peers', { skip: process.platform === 'win32' && 'Peer federation is supported only on macOS and Linux' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'peer-fleet-'));
    const fixtures = ['a', 'b', 'c'].map(fixture);
    const stores = fixtures.map((_, i) => new PeerStore(join(root, String(i))));
    const routers = fixtures.map(() => new ManagedEnvironmentRouter());
    const servers: ReturnType<typeof createBridgeServer>[] = [];
    const origins = new Map<string, string>();
    const clients: PeerT3Client[] = [];
    try {
      for (const [i, store] of stores.entries()) await store.initialize({ environmentId: fixtures[i]!.thread.title, label: fixtures[i]!.thread.title, origin: `https://host${i}.tail.ts.net` });
      const identities = await Promise.all(stores.map(async s => (await s.read()).identity));
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const incomingI = peerSecret(), incomingJ = peerSecret();
        await stores[i]!.update(s => s.peers.push({ ...identities[j]!, incomingHash: peerHash(incomingI), outgoingToken: incomingJ, state: 'paired', transactionId: 'fixture' }));
        await stores[j]!.update(s => s.peers.push({ ...identities[i]!, incomingHash: peerHash(incomingJ), outgoingToken: incomingI, state: 'paired', transactionId: 'fixture' }));
      }
      const factory = (peer: PeerEntry, local: PeerIdentity, maxBytes: number) => {
        const client = new PeerT3Client(peer, local, maxBytes, (_url, options) => new WebSocket(`${origins.get(peer.origin)}${PEER_PATH}`, PEER_PROTOCOL, options));
        clients.push(client); return client;
      };
      for (const [i, f] of fixtures.entries()) {
        const router = routers[i]!;
        router.register({ descriptor: await f.client.descriptor(), kind: 'local', client: f.client, primary: true });
        const server = createBridgeServer({ ...f.config, peerDirectory: stores[i]!.directory }, router, { transcribe: async () => '' }, factory);
        servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
        origins.set(identities[i]!.origin, `ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      }
      await eventually(async () => (await Promise.all(routers.map(r => r.snapshots()))).every(s => s.available.length === 3));
      for (const router of routers) {
        const snapshot = await router.snapshots();
        assert.deepEqual(snapshot.available.map(e => e.environment.environmentId).sort(), ['a', 'b', 'c']);
        assert.equal(snapshot.available.flatMap(e => e.shell.threads).length, 3);
      }
      const aToB = (await routers[0]!.resolve('b')).client;
      const shell = await aToB.shell();
      await aToB.sendMessage({ thread: shell.threads[0]!, text: 'only B' });
      // A confirmed mutation must leave the next action's shell lookup available.
      assert.equal((await aToB.shell()).threads.length, 1);
      assert.deepEqual(fixtures.map(f => f.calls.length), [0, 1, 0]);
      assert.equal((await aToB.thread('shared-thread')).thread.title, 'b');
      assert.equal((await aToB.threadPage!('shared-thread')).thread.title, 'b');
      assert.deepEqual(await aToB.modelCatalog(), { providers: [] });
      // Its exported shell contains only B, despite B importing both A and C.
      assert.equal((await (aToB as PeerT3Client).refreshShell()).threads.length, 1);
      const aOrigin = origins.get(identities[0]!.origin)!.replace('ws:', 'http:');
      const entry = (await stores[1]!.read()).peers.find(p => p.bridgeId === identities[0]!.bridgeId)!;
      const denied = await fetch(`${aOrigin}/v1/status`, { headers: { Authorization: `Bearer ${entry.outgoingToken}` } });
      assert.equal(denied.status, 401);
      for (const [route, headers, body, expected] of [
        ['/v1/peer/pair', { Origin: 'null' }, '{}', 403],
        ['/v1/peer/pair', {}, 'x'.repeat(17_000), 413],
        ['/v1/peer/confirm', { Authorization: `Bearer ${fixtures[0]!.config.bridgeToken}` }, '{}', 401],
      ] as const) {
        const response = await fetch(aOrigin + route, { method: 'POST', headers, body });
        assert.equal(response.status, expected); await response.body?.cancel();
      }
      // A slow owner's poll does not delay other owners or aggregate reads.
      const healthyShell = fixtures[1]!.client.shell;
      const releaseSlow: Array<() => void> = [];
      fixtures[1]!.client.shell = async () => { await new Promise<void>(resolve => { releaseSlow.push(resolve); }); return healthyShell(); };
      await eventually(async () => (await routers[0]!.list()).find(e => e.environmentId === 'b')?.status === 'offline');
      const before = Date.now();
      const partial = await routers[0]!.snapshots();
      assert.ok(Date.now() - before < 500);
      assert.ok(partial.available.some(e => e.environment.environmentId === 'c'));
      fixtures[1]!.client.shell = healthyShell; releaseSlow.forEach(resolve => resolve());
      await eventually(async () => (await routers[0]!.list()).find(e => e.environmentId === 'b')?.status === 'connected');
      const wrong = new WebSocket(`${origins.get(identities[0]!.origin)}${PEER_PATH}`, PEER_PROTOCOL, { headers: { Authorization: `Bearer ${fixtures[0]!.config.bridgeToken}` } });
      wrong.on('error', () => undefined);
      const [response] = await once(wrong, 'unexpected-response');
      assert.ok(response); wrong.terminate();
      await stores[1]!.revoke(identities[0]!.bridgeId);
      await eventually(async () => { try { await aToB.descriptor(); return false; } catch { return true; } });
      await eventually(async () => (await routers[0]!.list()).find(e => e.environmentId === 'b')?.status === 'offline');
      assert.equal((await routers[0]!.resolve('c')).environment.status, 'connected');
      assert.equal((await routers[0]!.resolve()).environment.environmentId, 'a');
    } finally {
      clients.forEach(c => c.close());
      await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve()))));
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('Windows PowerShell checks drop an inherited PowerShell 7 module path', async () => {
  const { windowsPowerShellEnvironment } = await import('../src/peer-store.js');
  const env = windowsPowerShellEnvironment({ PATH: '/bin', PSModulePath: 'C:\\pwsh7\\Modules', psmodulepath: 'x', HOME: '/home/test' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/test' });
});
