#!/usr/bin/env node
// Loopback-only UI fixture. No installed settings, real T3 credentials, or user data.
import { randomUUID } from 'node:crypto';
import { createBridgeServer } from '../bridge/dist/src/server.js';
import { loadConfig } from '../bridge/dist/src/config.js';

const config = loadConfig({
  BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: '18790', BRIDGE_POLL_INTERVAL_MS: '500',
  BRIDGE_TOKEN: 'faceclaw_fixture_token_local_only_123456789',
  BRIDGE_PASSPHRASE: 'local-faceclaw-fixture', BRIDGE_FACECLAW_PROJECT_ID: 'assistant',
});
let sequence = 1;
const now = () => new Date().toISOString();
const selection = { instanceId: 'fixture-codex', model: 'gpt-6-astra' };
const projects = ['assistant', 'faceclaw'].map(id => ({ id, title: id === 'assistant' ? 'General assistant' : 'Faceclaw development',
  workspaceRoot: process.cwd(), defaultModelSelection: selection, createdAt: now(), updatedAt: now() }));
const threads = new Map();
function createThread(id, projectId, title) {
  const at = now();
  const thread = { id, projectId, title, modelSelection: selection, runtimeMode: 'full-access', interactionMode: 'default',
    createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null, latestUserMessageAt: at,
    latestTurn: null, session: { status: 'idle', activeTurnId: null, updatedAt: at }, messages: [], activities: [] };
  threads.set(id, thread); return thread;
}
function message(thread, role, text, turnId = null) {
  const at = now();
  thread.messages.push({ id: randomUUID(), role, text, turnId, streaming: false, createdAt: at, updatedAt: at });
  thread.updatedAt = at; sequence++;
}
function run(thread, text) {
  const turnId = randomUUID(), at = now();
  message(thread, 'user', text, turnId);
  thread.latestTurn = { turnId, state: 'running', requestedAt: at, startedAt: at, completedAt: null };
  thread.session = { status: 'running', activeTurnId: turnId, updatedAt: at };
  thread.settledOverride = null; thread.settledAt = null;
  setTimeout(() => {
    message(thread, 'assistant', 'This is a local fixture response. Your message reached the bridge, and this completion can trigger the Faceclaw notification flow.\n\nNo real agent ran and no files or messages were changed.', turnId);
    thread.latestTurn.state = 'completed'; thread.latestTurn.completedAt = now();
    thread.session = { status: 'idle', activeTurnId: null, updatedAt: now() }; sequence++;
  }, 3000).unref();
  return { sequence };
}
const welcome = createThread('welcome', 'assistant', 'Welcome to T3 on Faceclaw');
message(welcome, 'user', 'What can I test here?');
message(welcome, 'assistant', 'Browse projects and sessions, read long replies, review dictated text, and start a fresh assistant conversation. New messages complete after three seconds so you can test the notification overlay.\n\nThis fixture uses the real bridge protocol and synthetic data.');
const plan = createThread('plan-demo', 'faceclaw', 'Choose a notification animation');
plan.interactionMode = 'plan'; plan.hasPendingUserInput = true;
plan.latestTurn = { turnId: 'plan-turn', state: 'running', requestedAt: now(), startedAt: now(), completedAt: null };
plan.session = { status: 'running', activeTurnId: 'plan-turn', updatedAt: now() };
plan.activities = [{ kind: 'user-input.requested', turnId: 'plan-turn', createdAt: now(), payload: { requestId: 'plan-request', questions: [
  { id: 'animation', header: 'Animation', question: 'Which overlay animation should we test?', multiSelect: false, options: [
    { label: 'Slide', description: 'A short vertical transition' }, { label: 'Fade', description: 'A gentle opacity transition' },
  ] },
] } }];
message(plan, 'assistant', 'Choose an animation to continue the local plan demonstration.', 'plan-turn');

const client = {
  async descriptor() { return { environmentId: 'fixture', label: 'Faceclaw fixture', serverVersion: 'fixture', capabilities: { threadSettlement: true } }; },
  async shell() { return { snapshotSequence: sequence, projects, threads: [...threads.values()], updatedAt: now() }; },
  async thread(id) { if (!threads.has(id)) throw new Error('Unknown fixture thread'); return { snapshotSequence: sequence, thread: threads.get(id) }; },
  async modelCatalog() { return { providers: [{ instanceId: selection.instanceId, label: 'Local fixture', models: ['gpt-6-astra', 'gpt-5.6-luna'].map(slug => ({ slug, name: slug, isDefault: slug === selection.model, reasoning: { id: 'reasoning', t3OptionId: 'reasoningEffort', defaultChoiceId: 'low', choices: [{ id: 'low', label: 'Low', isDefault: true }, { id: 'high', label: 'High', isDefault: false }] } })) }] }; },
  async startSession(input) { const thread = createThread(input.threadId, input.project.id, input.text.slice(0, 70)); thread.modelSelection = input.selection; return run(thread, input.text); },
  async sendMessage({ thread, text }) { return run(threads.get(thread.id), text); },
  async steerMessage({ thread, text }) { message(threads.get(thread.id), 'user', text); return { sequence }; },
  async settleThread(id) { const thread = threads.get(id); thread.settledOverride = 'settled'; thread.settledAt = now(); sequence++; return { sequence }; },
  async respondToPlanInput({ threadId }) { const thread = threads.get(threadId); thread.hasPendingUserInput = false; thread.activities = []; thread.interactionMode = 'default'; return run(thread, 'Continue with the selected animation.'); },
};
const server = createBridgeServer(config, client, { async transcribe() { return 'Please check the Faceclaw notification animation.'; } });
server.listen(config.port, config.host, () => {
  console.log('Faceclaw fixture: ws://10.0.2.2:18790/v1/faceclaw/events (Android emulator), or ws://127.0.0.1:18790/v1/faceclaw/events (host).');
  console.log('Pairing passphrase: local-faceclaw-fixture');
  console.log('Synthetic T3 and transcription only. No installed configuration or live agent is accessed.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref();
});
