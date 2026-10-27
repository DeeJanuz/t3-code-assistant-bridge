import { ApiError, isSafeId } from './security.js';
import { findProject, findThread } from './normalize.js';
import { freshAllowedThread, normalizePendingProposedPlan, requireIdleSession } from './session-controls.js';
import { normalizePendingPlanInput, validatePlanAnswers } from './plan-input.js';
import type { BridgeConfig, T3Client, T3NewSessionSelection } from './types.js';

export const PEER_READS = new Set(['descriptor', 'shell', 'thread', 'threadPage', 'modelCatalog']);
const invalid = () => new ApiError(400, 'invalid_request', 'Invalid peer operation');
export function peerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function only(p: Record<string, unknown>, keys: string[]) {
  if (Object.keys(p).some(k => !keys.includes(k))) throw invalid();
}
function id(v: unknown): string { if (typeof v !== 'string' || !isSafeId(v)) throw invalid(); return v; }
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) throw invalid();
  return v;
}
function selection(value: unknown): T3NewSessionSelection {
  const v = peerRecord(value); only(v, ['instanceId', 'model', 'reasoningId']);
  return { instanceId: id(v.instanceId), model: text(v.model, 256),
    ...(v.reasoningId === undefined ? {} : { reasoningId: id(v.reasoningId) }) };
}

/** The owner re-reads local state. No caller snapshot, URL or raw dispatch is accepted. */
export async function peerOperation(client: T3Client, config: BridgeConfig, method: string, input: unknown): Promise<unknown> {
  const p = peerRecord(input);
  if (method === 'descriptor' || method === 'modelCatalog') {
    only(p, []); return client[method]();
  }
  if (method === 'shell') {
    only(p, []);
    const shell = await client.shell();
    const projects = shell.projects.filter(project => {
      try { findProject(shell, project.id, config); return true; } catch { return false; }
    });
    const allowed = new Set(projects.map(project => project.id));
    return { ...shell, projects, threads: shell.threads.filter(t => allowed.has(t.projectId) && t.archivedAt === null) };
  }
  if (method === 'startSession') {
    only(p, ['projectId', 'threadId', 'text', 'selection']);
    const project = findProject(await client.shell(), id(p.projectId), config);
    return client.startSession({ project, threadId: id(p.threadId), text: text(p.text, config.maxTextChars),
      runtimeMode: 'full-access', ...(p.selection === undefined ? {} : { selection: selection(p.selection) }) });
  }
  const keys: Record<string, string[]> = {
    thread: [], threadPage: ['beforeCursor'], settleThread: [],
    sendMessage: ['text', 'interactionMode', 'reasoningId'], steerMessage: ['text'], replyMessage: ['text'],
    setModel: ['selection', 'expectedModel'], setReasoning: ['reasoningId', 'expectedModel'],
    approvePlan: ['planId', 'planMarkdown', 'commandId'],
    respondToPlanInput: ['requestId', 'commandId', 'answers'],
  };
  if (!Object.hasOwn(keys, method)) throw new ApiError(404, 'method_not_found', 'Unknown peer operation');
  only(p, ['threadId', ...keys[method]!]);
  const threadId = id(p.threadId);
  const thread = await freshAllowedThread(client, config, threadId);
  if (method === 'thread' || method === 'threadPage') {
    const result = method === 'thread' ? await client.thread(threadId) : await client.threadPage?.(threadId,
      p.beforeCursor === undefined ? undefined : text(p.beforeCursor, 4096));
    if (!result) throw new ApiError(502, 'upstream_incompatible', 'Transcript pagination is unavailable');
    if (result.thread.id !== threadId || result.thread.projectId !== thread.projectId || result.thread.archivedAt !== null) throw invalid();
    return result;
  }
  if (method === 'steerMessage') {
    if (!['running', 'starting'].includes(thread.session?.status ?? '') || !thread.session?.activeTurnId) {
      throw new ApiError(409, 'session_not_running', 'This session is not running');
    }
    return client.steerMessage({ thread, text: text(p.text, config.maxTextChars) });
  }
  if (method === 'replyMessage') {
    const status = thread.session?.status ?? 'idle';
    const active = ['running', 'starting'].includes(status) || thread.session?.activeTurnId != null || thread.latestTurn?.state === 'running';
    const idle = ['idle', 'ready', 'interrupted', 'stopped', 'error'].includes(status) &&
      thread.session?.activeTurnId == null && thread.latestTurn?.state !== 'running';
    if (!active && !idle) throw new ApiError(502, 'upstream_invalid_response', 'T3 Code returned an invalid session state');
    return client.replyMessage({ thread, text: text(p.text, config.maxTextChars) });
  }
  if (method === 'respondToPlanInput') {
    const pending = normalizePendingPlanInput(thread);
    if (!pending || pending.requestId !== p.requestId) throw new ApiError(409, 'plan_unavailable', 'Questions are no longer available');
    const answers = peerRecord(p.answers);
    if (Object.keys(answers).length !== pending.questions.length) throw invalid();
    const canonical = validatePlanAnswers(pending.questions.map(q => {
      const answer = answers[q.id];
      if (Array.isArray(answer)) {
        return { questionId: q.id, text: '', optionIndexes: answer.map(a => q.options.findIndex(o => o.label === a)) };
      }
      return { questionId: q.id, text: text(answer, config.maxTextChars), optionIndexes: [] };
    }), pending, config.maxTextChars);
    return client.respondToPlanInput({ threadId, requestId: pending.requestId, commandId: id(p.commandId), answers: canonical });
  }
  if (method !== 'replyMessage') requireIdleSession(thread);
  if (method === 'settleThread') return client.settleThread(threadId);
  if (method === 'sendMessage') {
    if (p.interactionMode !== undefined && !['default', 'plan'].includes(String(p.interactionMode))) throw invalid();
    return client.sendMessage({ thread, text: text(p.text, config.maxTextChars),
      ...(p.interactionMode === undefined ? {} : { interactionMode: p.interactionMode as 'default' | 'plan' }),
      ...(p.reasoningId === undefined ? {} : { reasoningId: id(p.reasoningId) }) });
  }
  if (method === 'approvePlan') {
    const plan = normalizePendingProposedPlan(thread);
    if (!plan || plan.planId !== p.planId || plan.planMarkdown !== p.planMarkdown) throw new ApiError(409, 'plan_unavailable', 'Plan is no longer available');
    if (!client.approvePlan) throw new ApiError(502, 'upstream_incompatible', 'Plan approval is unavailable');
    return client.approvePlan({ thread, planId: plan.planId, planMarkdown: plan.planMarkdown, commandId: id(p.commandId) });
  }
  const expected = peerRecord(p.expectedModel); only(expected, ['instanceId', 'model']);
  if (expected.instanceId !== thread.modelSelection.instanceId || expected.model !== thread.modelSelection.model) {
    throw new ApiError(409, 'model_selection_changed', 'The session model changed');
  }
  if (method === 'setModel' && client.setModel) return client.setModel({ thread, selection: selection(p.selection) });
  if (method === 'setReasoning' && client.setReasoning) return client.setReasoning({ thread, reasoningId: id(p.reasoningId) });
  throw new ApiError(502, 'upstream_incompatible', 'Session control is unavailable');
}
