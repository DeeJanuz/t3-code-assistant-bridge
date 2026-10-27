import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { faceclawToken, launcherToken, verifyToolToken } from '../src/faceclaw.js';
import { FaceclawProviderGrants } from '../src/faceclaw-provider.js';
import { createLauncherProfile } from '../src/faceclaw-setup.js';
import { readLauncherConfig, validateLauncherConfig } from '../src/faceclaw-launcher.js';
import { createBridgeServer } from '../src/server.js';
import type { T3Client, Transcriber } from '../src/types.js';

const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const clientFor = (workspaceRoot: string) => ({ shell: async () => ({ snapshotSequence: 1, projects: [{ id: 'assistant', workspaceRoot, title: 'Assistant' }], threads: [] }) }) as unknown as T3Client;

test('provider grants require isolated launcher credential, actual configured project path, and private lease to renew', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-grant-'));
  const config = loadConfig({ BRIDGE_TOKEN: secret, BRIDGE_FACECLAW_PROJECT_ID: 'assistant' });
  const grants = new FaceclawProviderGrants(config, clientFor(dir), 'process-key');
  try {
    for (const wrong of [secret, faceclawToken(secret), launcherToken(secret, 'other')]) await assert.rejects(grants.issue(wrong, { cwd: dir }), /credential/);
    await assert.rejects(grants.issue(launcherToken(secret, 'assistant'), { cwd: tmpdir() }), /outside/);
    const issued = await grants.issue(launcherToken(secret, 'assistant'), { cwd: dir });
    const binding = verifyToolToken('process-key', issued.token, 'assistant');
    assert.equal(binding.bindingKind, 'provider-session'); assert.equal(binding.threadId, undefined);
    grants.validate(binding);
    assert.throws(() => grants.renew(binding, issued.token), /lease credential/);
    assert.deepEqual(grants.renew(binding, issued.leaseToken), { renewed: true });
    grants.revoke(binding, issued.leaseToken);
    assert.throws(() => grants.validate(binding), /expired/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launcher setup preserves existing configs and excludes master token; mode and endpoint checks fail closed', { skip: process.platform === 'win32' && 'The provider launcher is supported only on macOS and Linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-config-'));
  try {
    const env = { BRIDGE_TOKEN: secret, BRIDGE_FACECLAW_PROJECT_ID: 'assistant', FACECLAW_CODEX_PATH: process.execPath, FACECLAW_WORKSPACE_ROOT: dir };
    const path = await createLauncherProfile(join(dir, 'profile'), env);
    const configPath = join(dir, 'profile', 'launcher.json');
    const config = await readLauncherConfig(configPath);
    assert.notEqual(config.launcherToken, secret);
    assert(!(await readFile(configPath, 'utf8')).includes(secret));
    assert((await readFile(path, 'utf8')).includes('runFaceclawLauncher'));
    await assert.rejects(createLauncherProfile(join(dir, 'profile'), env));
    assert.throws(() => validateLauncherConfig({ ...config, bridgeOrigin: 'https://example.com' }));
    if (process.platform !== 'win32') { await chmod(configPath, 0o644); await assert.rejects(readLauncherConfig(configPath), /owner-only/); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('automatic provider launcher injects scoped MCP, relays a tool to authenticated phone, and revokes at exit', { skip: process.platform === 'win32' && 'The provider launcher is supported only on macOS and Linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-integration-'));
  const workspace = join(dir, 'assistant'); await mkdir(workspace);
  const config = loadConfig({ BRIDGE_TOKEN: secret, BRIDGE_FACECLAW_PROJECT_ID: 'assistant', BRIDGE_POLL_INTERVAL_MS: '60000' });
  const server = createBridgeServer(config, clientFor(workspace), {} as Transcriber);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/faceclaw/events', ['even-t3-v1', `auth.${faceclawToken(secret)}`]);
  let providerToken = '';
  try {
    await once(socket, 'open');
    const registered = new Promise<void>(resolve => socket.on('message', data => {
      const value = JSON.parse(data.toString());
      if (value.id === 'register' && value.ok) resolve();
      if (value.event === 'faceclaw.capability.call') {
        assert.equal(value.payload.bindingKind, 'provider-session');
        assert.equal(value.payload.threadId, undefined);
        socket.send(JSON.stringify({ v: 1, type: 'request', id: 'result', method: 'faceclaw.capabilities.result', params: { callId: value.payload.callId, result: { content: [{ type: 'text', text: 'shown' }] } } }));
      }
    }));
    socket.send(JSON.stringify({ v: 1, type: 'request', id: 'register', method: 'faceclaw.capabilities.register', params: { protocolVersion: 1, catalogRevision: 1, projectId: 'assistant', tools: [{ name: 'display_text', description: 'Show text', inputSchema: { type: 'object' } }] } }));
    await registered;
    const executable = join(dir, 'fake-codex.mjs');
    await writeFile(executable, `#!/usr/bin/env node\nconst config=process.argv.find(x=>x.startsWith('mcp_servers.faceclaw='));if(!config || process.env.BRIDGE_TEST_SECRET) process.exit(2);const url=JSON.parse(config.match(/url=(\"[^\"]+\")/)[1]);const token=process.env.FACECLAW_SESSION_TOKEN;const send=async(id,method,params={})=>(await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})})).json();const tools=await send(1,'tools/list');const result=await send(2,'tools/call',{name:tools.result.tools[0].name,arguments:{text:'hello'}});process.stdout.write(JSON.stringify({result,token}));\n`, { mode: 0o700 });
    const entry = await createLauncherProfile(join(dir, 'profile'), { BRIDGE_TOKEN: secret, BRIDGE_FACECLAW_PROJECT_ID: 'assistant', FACECLAW_CODEX_PATH: executable, FACECLAW_WORKSPACE_ROOT: workspace, FACECLAW_BRIDGE_ORIGIN: base });
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, entry, 'app-server'], { cwd: workspace, env: { ...process.env, BRIDGE_TEST_SECRET: 'must-not-reach-provider' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => errors += d);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    const value = JSON.parse(output); providerToken = value.token;
    assert.deepEqual(value.result.result, { content: [{ type: 'text', text: 'shown' }] });
    const after = await fetch(base + '/v1/faceclaw/mcp', { method: 'POST', headers: { Authorization: `Bearer ${providerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
    assert.equal(after.status, 403);
  } finally { socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
