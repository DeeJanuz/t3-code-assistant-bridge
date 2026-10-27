import { createHash } from "node:crypto";
import { findProject, findThread } from "./normalize.js";
import { ApiError, isSafeId } from "./security.js";
import type { BridgeConfig, T3Client, T3Thread } from "./types.js";

export interface PlanQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}
export interface PendingPlanInput {
  requestId: string;
  revision: string;
  turnId: string | null;
  createdAt: string;
  questions: PlanQuestion[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  return value === iso || value === iso.replace(".000Z", "Z") ? iso : null;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function questions(value: unknown): PlanQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return null;
  const result: PlanQuestion[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const q = record(item);
    if (!q || !text(q.id, 2000) || !text(q.header, 200) || !text(q.question, 4000) ||
        ids.has(q.id) || !Array.isArray(q.options) || q.options.length > 12 ||
        !(q.multiSelect === undefined || typeof q.multiSelect === "boolean")) return null;
    const options: PlanQuestion["options"] = [];
    const labels = new Set<string>();
    for (const item of q.options) {
      const option = record(item);
      if (!option || !text(option.label, 500) || !text(option.description, 2000) ||
          labels.has(option.label)) return null;
      labels.add(option.label);
      options.push({ label: option.label, description: option.description });
    }
    ids.add(q.id);
    result.push({ id: q.id, header: q.header, question: q.question, options, multiSelect: q.multiSelect === true });
  }
  return JSON.stringify(result).length <= 32_000 ? result : null;
}

/** Only the provider's structured user-input lifecycle is actionable, never approvals. */
export function normalizePendingPlanInput(thread: T3Thread): PendingPlanInput | null {
  if (!["default", "plan"].includes(thread.interactionMode) || thread.archivedAt !== null ||
      thread.hasPendingUserInput === false || thread.latestTurn?.state !== "running" ||
      !thread.session || !["running", "ready"].includes(thread.session.status) ||
      (thread.session.activeTurnId != null && thread.session.activeTurnId !== thread.latestTurn.turnId) ||
      !Array.isArray(thread.activities) || thread.activities.length > 10_000) return null;
  const events = thread.activities.flatMap((raw, index) => {
    const activity = record(raw);
    const payload = record(activity?.payload);
    const at = timestamp(activity?.createdAt);
    if (!activity || !payload || !text(payload.requestId, 256) || !at ||
        !["user-input.requested", "user-input.resolved", "provider.user-input.respond.failed"].includes(String(activity.kind))) return [];
    return [{ activity, payload, at, index }];
  }).sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
  const pending = new Map<string, PendingPlanInput>();
  const closed = new Set<string>();
  for (const { activity, payload, at } of events) {
    const requestId = payload.requestId as string;
    // Treat any response failure as no longer actionable in this client. T3
    // can display the provider detail; the bridge never exposes that payload.
    if (activity.kind !== "user-input.requested") { pending.delete(requestId); closed.add(requestId); continue; }
    if (closed.has(requestId)) continue;
    const parsed = questions(payload.questions);
    const turnId = activity.turnId == null ? null : activity.turnId;
    if (!parsed || (turnId !== null && (typeof turnId !== "string" ||
        !isSafeId(turnId) || turnId !== thread.latestTurn.turnId))) {
      pending.delete(requestId);
      continue;
    }
    const content = { requestId, turnId, createdAt: at, questions: parsed };
    pending.set(requestId, { ...content, revision: digest(content) });
  }
  return [...pending.values()].at(-1) ?? null;
}

const MAX_PENDING_QUESTION_LOOKUPS = 8;
const MAX_PENDING_QUESTION_CHARS = 280;

/**
 * Give blocked sessions the first pending question so glasses alerts can lead
 * with it. The shell has no question text, so this reads each thread. Lookups
 * are bounded and best effort; a failure leaves the session without a preview.
 */
export async function attachPendingQuestions<T extends {
  id: string; projectId: string; environmentId?: string; hasPendingUserInput?: boolean; pendingQuestion?: string;
}>(sessions: readonly T[], clientFor: (environmentId?: string) => Pick<T3Client, "thread"> | undefined): Promise<void> {
  await Promise.all(sessions.filter((session) => session.hasPendingUserInput === true)
    .slice(0, MAX_PENDING_QUESTION_LOOKUPS).map(async (session) => {
      const client = clientFor(session.environmentId);
      if (!client) return;
      try {
        const snapshot = await client.thread(session.id);
        if (snapshot.thread.id !== session.id || snapshot.thread.projectId !== session.projectId) return;
        const pending = normalizePendingPlanInput(snapshot.thread);
        const first = pending?.questions[0];
        if (!pending || !first) return;
        const flat = first.question.replace(/\s+/gu, " ").trim();
        const more = pending.questions.length - 1;
        const suffix = more > 0 ? ` (+${more} more)` : "";
        const limit = MAX_PENDING_QUESTION_CHARS - suffix.length;
        session.pendingQuestion = (flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`) + suffix;
      } catch { /* The alert falls back to the session title. */ }
    }));
}

function unavailable(): ApiError {
  return new ApiError(409, "plan_request_unavailable", "These questions are no longer available. Refresh the session.");
}
function invalid(): ApiError {
  return new ApiError(400, "invalid_plan_answers", "Review and answer every question before submitting.");
}

export function validatePlanAnswers(value: unknown, pending: PendingPlanInput, maxChars: number): Record<string, string | string[]> {
  if (!Array.isArray(value) || value.length !== pending.questions.length) throw invalid();
  const answers = new Map<string, string | string[]>();
  let length = 0;
  for (const item of value) {
    const answer = record(item);
    if (!answer || Object.keys(answer).some((key) => !["questionId", "optionIndexes", "text"].includes(key)) ||
        typeof answer.questionId !== "string" || answers.has(answer.questionId)) throw invalid();
    const question = pending.questions.find((q) => q.id === answer.questionId);
    if (!question || !Array.isArray(answer.optionIndexes) || answer.optionIndexes.length > question.options.length ||
        typeof answer.text !== "string" || answer.text.length > maxChars) throw invalid();
    const custom = answer.text.trim();
    if (custom) {
      if (answer.optionIndexes.length !== 0 || !text(custom, maxChars)) throw invalid();
      length += custom.length;
      answers.set(question.id, custom);
    } else {
      if (answer.optionIndexes.length === 0 || (!question.multiSelect && answer.optionIndexes.length !== 1)) throw invalid();
      const indexes = new Set<number>();
      const selected: string[] = [];
      for (const index of answer.optionIndexes) {
        if (!Number.isInteger(index) || index < 0 || index >= question.options.length || indexes.has(index)) throw invalid();
        indexes.add(index);
        selected.push(question.options[index]!.label);
      }
      length += selected.reduce((sum, label) => sum + label.length, 0);
      answers.set(question.id, question.multiSelect ? selected : selected[0]!);
    }
  }
  if (length > maxChars) throw invalid();
  // Object.fromEntries safely treats prose IDs such as "__proto__" as data.
  return Object.fromEntries(pending.questions.map((q) => [q.id, answers.get(q.id)!]));
}

interface Submission {
  fingerprint: string;
  result: Promise<{ threadId: string; requestId: string; sequence: number }>;
}

export class PlanInputService {
  private readonly submissions = new Map<string, Submission>();
  constructor(private readonly client: Pick<T3Client, "shell" | "thread" | "respondToPlanInput">, private readonly config: BridgeConfig) {}

  async submit(params: Record<string, unknown>) {
    if (Object.keys(params).some((key) => !["threadId", "requestId", "revision", "answers"].includes(key)) ||
        typeof params.threadId !== "string" || !isSafeId(params.threadId) ||
        !text(params.requestId, 256) || typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)) throw invalid();
    const { threadId, requestId } = params;
    const shell = await this.client.shell();
    const allowed = findThread(shell, threadId, this.config);
    findProject(shell, allowed.projectId, this.config);
    const snapshot = await this.client.thread(threadId);
    if (snapshot.thread.id !== threadId || snapshot.thread.projectId !== allowed.projectId) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    const pending = normalizePendingPlanInput(snapshot.thread);
    if (!pending || pending.requestId !== requestId || pending.revision !== params.revision || !["default", "plan"].includes(allowed.interactionMode)) throw unavailable();
    const answers = validatePlanAnswers(params.answers, pending, this.config.maxTextChars);
    const key = digest([threadId, requestId]);
    const fingerprint = digest([pending.revision, answers]);
    const previous = this.submissions.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, "plan_submission_conflict", "A response was already submitted for these questions. Refresh the session.");
      return previous.result;
    }
    if (this.submissions.size >= 256) this.submissions.delete(this.submissions.keys().next().value!);
    const result = this.client.respondToPlanInput({
      threadId, requestId, answers,
      // T3 durably deduplicates commands. Reconnects/restarts cannot dispatch
      // a second response intent for this request, even after cache eviction.
      commandId: `even-plan-${key}`,
    }).then(({ sequence }) => ({ threadId, requestId, sequence }), () => {
      throw new ApiError(502, "plan_submission_uncertain", "Submission could not be confirmed. Refresh this session in T3 Code before trying again.");
    });
    this.submissions.set(key, { fingerprint, result });
    return result;
  }
}
