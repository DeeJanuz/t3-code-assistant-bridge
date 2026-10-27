import { createHash } from "node:crypto";
import { findProject, findThread } from "./normalize.js";
import { ApiError, isSafeId } from "./security.js";
import type { BridgeConfig, T3Client, T3NewSessionSelection, T3Thread, T3ThreadShell } from "./types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) &&
    [new Date(value).toISOString(), new Date(value).toISOString().replace(".000Z", "Z")].includes(value);
}
function invalid(): ApiError { return new ApiError(400, "invalid_request", "Invalid session control request"); }
function unavailable(): ApiError { return new ApiError(409, "plan_unavailable", "This plan is no longer available. Refresh the session."); }

export function requireIdleSession(thread: T3ThreadShell): void {
  const status = thread.session === null ? "idle" : thread.session?.status;
  if (!["idle", "ready", "interrupted", "stopped", "error"].includes(status ?? "") ||
      thread.session?.activeTurnId != null || thread.latestTurn?.state === "running" || thread.hasPendingUserInput === true) {
    throw new ApiError(409, "session_busy", "Wait for the current turn and pending input to finish");
  }
  if ((thread.latestTurn !== null && !["completed", "interrupted", "error"].includes(thread.latestTurn?.state)) ||
      (thread.hasPendingUserInput !== undefined && typeof thread.hasPendingUserInput !== "boolean")) {
    throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid session state");
  }
}

export interface PendingProposedPlan {
  planId: string;
  revision: string;
  turnId: string;
  planMarkdown: string;
  createdAt: string;
  updatedAt: string;
}

/** Only a structured, unimplemented plan from the latest completed turn is actionable. */
export function normalizePendingProposedPlan(thread: T3Thread): PendingProposedPlan | null {
  try { requireIdleSession(thread); } catch { return null; }
  if (thread.interactionMode !== "plan" || thread.archivedAt !== null || thread.latestTurn?.state !== "completed" ||
      !isSafeId(thread.latestTurn.turnId) || !Array.isArray(thread.proposedPlans) || thread.proposedPlans.length > 200) return null;
  const candidates = thread.proposedPlans.filter((candidate) => record(candidate) && candidate.turnId === thread.latestTurn!.turnId);
  if (candidates.length === 0) return null;
  // Do not fall back to an older actionable plan when newer data is malformed.
  if (candidates.some((candidate) => !record(candidate) || !timestamp(candidate.createdAt) || !timestamp(candidate.updatedAt))) return null;
  const candidate = [...candidates].sort((a, b) => String((a as Record<string, unknown>).updatedAt).localeCompare(String((b as Record<string, unknown>).updatedAt))).at(-1);
  if (!record(candidate) || !text(candidate.id, 256) || !text(candidate.planMarkdown, 64_000) ||
      candidate.implementedAt !== null || candidate.implementationThreadId !== null ||
      !timestamp(candidate.createdAt) || !timestamp(candidate.updatedAt) ||
      candidates.filter((p) => record(p) && p.id === candidate.id).length !== 1) return null;
  const plan = { planId: candidate.id, turnId: thread.latestTurn.turnId,
    planMarkdown: candidate.planMarkdown, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt };
  return { ...plan, revision: digest(plan) };
}

export async function freshAllowedThread(client: Pick<T3Client, "shell" | "thread">, config: BridgeConfig, threadId: string): Promise<T3Thread> {
  const shell = await client.shell();
  const allowed = findThread(shell, threadId, config);
  findProject(shell, allowed.projectId, config);
  const snapshot = await client.thread(threadId);
  if (snapshot.thread.id !== threadId || snapshot.thread.projectId !== allowed.projectId) {
    throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
  }
  if (snapshot.thread.archivedAt !== null) throw new ApiError(404, "not_found", "Session not found");
  return snapshot.thread;
}

export class SessionControlsService {
  private readonly approvals = new Map<string, Promise<{ threadId: string; planId: string; sequence: number }>>();
  constructor(private readonly client: Pick<T3Client, "shell" | "thread" | "approvePlan" | "setModel" | "setReasoning">, private readonly config: BridgeConfig) {}

  async setModel(params: Record<string, unknown>) {
    if (Object.keys(params).some((key) => !["threadId", "selection", "expectedModel"].includes(key)) ||
        typeof params.threadId !== "string" || !isSafeId(params.threadId) || !record(params.selection) ||
        Object.keys(params.selection).some((key) => !["instanceId", "model", "reasoningId"].includes(key)) ||
        !text(params.selection.instanceId, 128) || !isSafeId(params.selection.instanceId) ||
        !text(params.selection.model, 256) || !record(params.expectedModel) ||
        Object.keys(params.expectedModel).some((key) => !["instanceId", "model"].includes(key)) ||
        !text(params.expectedModel.instanceId, 128) || !text(params.expectedModel.model, 256) ||
        (params.selection.reasoningId !== undefined && (!text(params.selection.reasoningId, 128) || !isSafeId(params.selection.reasoningId)))) {
      throw invalid();
    }
    const thread = await freshAllowedThread(this.client, this.config, params.threadId);
    requireIdleSession(thread);
    if (thread.modelSelection.instanceId !== params.expectedModel.instanceId || thread.modelSelection.model !== params.expectedModel.model) {
      throw new ApiError(409, "model_selection_changed", "The session model changed. Refresh the session.");
    }
    if (!this.client.setModel) throw new ApiError(502, "upstream_incompatible", "Session model controls are unavailable");
    const selection: T3NewSessionSelection = {
      instanceId: params.selection.instanceId as string,
      model: params.selection.model as string,
      ...(params.selection.reasoningId === undefined ? {} : { reasoningId: params.selection.reasoningId as string }),
    };
    const result = await this.client.setModel({ thread, selection });
    return { threadId: thread.id, modelSelection: selection, sequence: result.sequence };
  }

  async setReasoning(params: Record<string, unknown>) {
    if (Object.keys(params).some((key) => !["threadId", "reasoningId", "expectedModel"].includes(key)) ||
        typeof params.threadId !== "string" || !isSafeId(params.threadId) ||
        !text(params.reasoningId, 128) || !isSafeId(params.reasoningId) || !record(params.expectedModel) ||
        Object.keys(params.expectedModel).some((key) => !["instanceId", "model"].includes(key)) ||
        !text(params.expectedModel.instanceId, 128) || !text(params.expectedModel.model, 256)) throw invalid();
    const thread = await freshAllowedThread(this.client, this.config, params.threadId);
    requireIdleSession(thread);
    if (thread.modelSelection.instanceId !== params.expectedModel.instanceId || thread.modelSelection.model !== params.expectedModel.model) {
      throw new ApiError(409, "model_selection_changed", "The session model changed. Refresh the session.");
    }
    if (!this.client.setReasoning) throw new ApiError(502, "upstream_incompatible", "Session reasoning controls are unavailable");
    const result = await this.client.setReasoning({ thread, reasoningId: params.reasoningId });
    return { threadId: thread.id, reasoningId: params.reasoningId, sequence: result.sequence };
  }

  async approve(params: Record<string, unknown>) {
    if (Object.keys(params).some((key) => !["threadId", "planId", "revision"].includes(key)) ||
        typeof params.threadId !== "string" || !isSafeId(params.threadId) || !text(params.planId, 256) ||
        typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)) throw invalid();
    const thread = await freshAllowedThread(this.client, this.config, params.threadId);
    const plan = normalizePendingProposedPlan(thread);
    if (!plan || plan.planId !== params.planId || plan.revision !== params.revision) throw unavailable();
    if (!this.client.approvePlan) throw new ApiError(502, "upstream_incompatible", "Plan implementation is unavailable");
    const key = digest([thread.id, plan.planId, plan.revision]);
    const previous = this.approvals.get(key);
    if (previous) return previous;
    if (this.approvals.size >= 256) this.approvals.delete(this.approvals.keys().next().value!);
    // Stable command IDs survive reconnects/restarts. Failed/ambiguous dispatches
    // stay locked; never silently retry an implementation intent.
    const result = this.client.approvePlan({ thread, planId: plan.planId, planMarkdown: plan.planMarkdown,
      commandId: `even-implement-${key}` }).then(({ sequence }) => ({ threadId: thread.id, planId: plan.planId, sequence }), () => {
      throw new ApiError(502, "plan_approval_uncertain", "Implementation could not be confirmed. Refresh this session in T3 Code before trying again.");
    });
    this.approvals.set(key, result);
    return result;
  }
}
