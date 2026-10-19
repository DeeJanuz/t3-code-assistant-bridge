import { createHash } from "node:crypto";
import type {
  T3LatestTurn,
  T3Message,
  T3ModelSelection,
  T3Project,
  T3SessionState,
  T3ShellSnapshot,
  T3Thread,
  T3ThreadActivity,
  T3ThreadShell,
  T3ThreadSnapshot,
} from "./types.js";

/**
 * T3 Code orchestration V2 adapter. V2 replaced the V1 thread model (session,
 * latestTurn, activities) with runs, turn items and runtime requests. These
 * functions map V2 snapshots onto the bridge's internal shapes so transcript
 * normalization, peers and the glasses wire format stay unchanged.
 *
 * Source contract: T3 Code `packages/contracts/src/orchestrationV2.ts` and
 * `apps/server/src/orchestration-v2/ProjectionStore.ts` (`threadShellFromProjection`)
 * at 0.0.46-nightly.20261013.3053. All input is untrusted: unknown values degrade
 * to "absent" and invalid structure fails as an incompatible response.
 */

export const ORCHESTRATION_PROTOCOL_VERSION = "2";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";

export class V2ShapeError extends Error {}

type Json = Record<string, unknown>;

function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new V2ShapeError("Invalid T3 orchestration V2 payload");
  return value;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Archive and activity ids allow a narrower alphabet than V2 entity ids. */
function activityId(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
    ? value
    : `v2:${createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
}

const STARTING_RUN = new Set(["preparing", "queued", "starting"]);
const RUNNING_RUN = new Set(["running", "waiting"]);

interface RunSummary {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function turnState(status: string): string {
  if (STARTING_RUN.has(status) || RUNNING_RUN.has(status)) return "running";
  if (status === "completed" || status === "rolled_back") return "completed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed") return "error";
  return status;
}

function sessionStatus(status: string): string {
  if (STARTING_RUN.has(status)) return "starting";
  if (RUNNING_RUN.has(status)) return "running";
  if (status === "completed" || status === "rolled_back") return "ready";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  if (status === "failed") return "error";
  return status;
}

function runState(run: RunSummary | null, updatedAt: string): Pick<T3ThreadShell, "latestTurn" | "session"> {
  if (run === null) return { latestTurn: null, session: null };
  const state = turnState(run.status);
  const latestTurn: T3LatestTurn = {
    turnId: run.id,
    state,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    completedAt: state === "running" ? null : run.completedAt,
  };
  const session: T3SessionState = {
    status: sessionStatus(run.status),
    activeTurnId: state === "running" ? run.id : null,
    updatedAt: run.completedAt ?? run.startedAt ?? updatedAt,
  };
  return { latestTurn, session };
}

function modelSelection(value: unknown): T3ModelSelection {
  if (!record(value)) throw new V2ShapeError("Invalid model selection");
  const instanceId = required(nonEmpty(value.instanceId));
  const model = required(nonEmpty(value.model));
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option) => record(option) && typeof option.id === "string" &&
        (typeof option.value === "string" || typeof option.value === "boolean")
        ? [{ id: option.id, value: option.value }] : [])
    : undefined;
  return { instanceId, model, ...(options === undefined ? {} : { options }) };
}

function interactionMode(value: unknown): "default" | "plan" {
  return value === "plan" ? "plan" : "default";
}

function settledOverride(value: unknown): "settled" | "active" | null {
  return value === "settled" || value === "active" ? value : null;
}

function baseThread(thread: Json): Omit<T3ThreadShell, "latestTurn" | "session"> {
  return {
    id: required(nonEmpty(thread.id)),
    projectId: required(nonEmpty(thread.projectId)),
    title: required(string(thread.title)),
    modelSelection: modelSelection(thread.modelSelection),
    runtimeMode: required(nonEmpty(thread.runtimeMode)) as T3ThreadShell["runtimeMode"],
    interactionMode: interactionMode(thread.interactionMode),
    createdAt: required(nonEmpty(thread.createdAt)),
    updatedAt: required(nonEmpty(thread.updatedAt)),
    archivedAt: nullableString(thread.archivedAt),
    settledOverride: settledOverride(thread.settledOverride),
    settledAt: nullableString(thread.settledAt),
    unsettledAt: nullableString(thread.unsettledAt),
  };
}

/**
 * Background work from the V2 shell roster: subagents and opaque tasks are work; only monitors are monitoring.
 * Background shell commands (Claude `run_in_background`, Codex background commands) can outlive the session
 * indefinitely, so T3 itself does not count them as live work. Neither does the bridge.
 */
function backgroundFromTasks(tasks: readonly unknown[]): "working" | "monitoring" | undefined {
  const kinds = tasks.flatMap((task) => record(task) ? [String(task.kind ?? "background_task")] : [])
    .filter((kind) => kind !== "command");
  if (kinds.length === 0) return undefined;
  return kinds.every((kind) => kind === "monitor") ? "monitoring" : "working";
}

export function shellThreadFromV2(value: unknown): T3ThreadShell {
  if (!record(value)) throw new V2ShapeError("Invalid thread shell");
  const latestRunId = nonEmpty(value.latestRunId);
  const status = string(value.status) ?? "idle";
  const run: RunSummary | null = latestRunId === null || status === "idle" ? null : {
    id: latestRunId,
    status,
    requestedAt: string(value.latestRunRequestedAt) ?? required(nonEmpty(value.updatedAt)),
    startedAt: nullableString(value.latestRunStartedAt),
    completedAt: nullableString(value.latestRunCompletedAt),
  };
  const pending = record(value.pendingRuntimeRequest) ? value.pendingRuntimeRequest : null;
  const background = backgroundFromTasks(array(value.pendingBackgroundTasks));
  const base = baseThread(value);
  return {
    ...base,
    latestUserMessageAt: nullableString(value.latestUserMessageAt),
    hasPendingUserInput: pending?.kind === "user_input",
    ...(background === undefined ? {} : { backgroundLiveness: background }),
    ...runState(run, base.updatedAt),
  };
}

function projectFromV2(value: unknown): T3Project {
  if (!record(value)) throw new V2ShapeError("Invalid project");
  return {
    id: required(nonEmpty(value.id)),
    title: required(string(value.title)),
    ...(typeof value.workspaceRoot === "string" ? { workspaceRoot: value.workspaceRoot } : {}),
    defaultModelSelection: value.defaultModelSelection == null ? null : modelSelection(value.defaultModelSelection),
    deletedAt: nullableString(value.deletedAt),
    createdAt: required(nonEmpty(value.createdAt)),
    updatedAt: required(nonEmpty(value.updatedAt)),
  };
}

export function shellFromV2(value: unknown): T3ShellSnapshot {
  if (!record(value) || !Number.isSafeInteger(value.snapshotSequence) ||
      !Array.isArray(value.projects) || !Array.isArray(value.threads)) {
    throw new V2ShapeError("Invalid shell snapshot");
  }
  const threads = value.threads.map(shellThreadFromV2);
  const times = threads.map((thread) => thread.updatedAt).filter((time) => Number.isFinite(Date.parse(time)));
  return {
    snapshotSequence: value.snapshotSequence as number,
    projects: value.projects.map(projectFromV2),
    threads,
    // V2 shells carry no snapshot time; the newest thread update stands in.
    updatedAt: times.sort().at(-1) ?? new Date(0).toISOString(),
  };
}

function runFromProjection(value: unknown): (RunSummary & { readonly ordinal: number; readonly queueHeld: boolean }) | null {
  if (!record(value)) return null;
  const id = nonEmpty(value.id);
  const status = nonEmpty(value.status);
  const requestedAt = nonEmpty(value.requestedAt);
  if (id === null || status === null || requestedAt === null || !Number.isSafeInteger(value.ordinal)) return null;
  return {
    id, status, requestedAt,
    startedAt: nullableString(value.startedAt),
    completedAt: nullableString(value.completedAt),
    ordinal: value.ordinal as number,
    queueHeld: value.queueHeld === true,
  };
}

const TOOL_ITEM_TYPES = new Set(["command_execution", "file_change", "file_search", "web_search", "dynamic_tool", "subagent"]);
const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Tool labels read at most this much source text, so longer input is never copied. */
const MAX_TOOL_PREVIEW_CHARS = 2048;

function preview(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_TOOL_PREVIEW_CHARS) : null;
}

/** Shapes a V2 tool item as the V1 activity payload the label code understands. */
function toolPayload(item: Json): Json {
  const toolCallId = string(item.id);
  const base = toolCallId === null ? {} : { toolCallId: activityId(toolCallId) };
  switch (item.type) {
    case "command_execution":
      return { ...base, itemType: "command_execution", data: { command: preview(item.input) } };
    case "file_change": {
      const changes = array(item.changes).slice(0, 100).flatMap((change) => record(change) && typeof change.path === "string" ? [{ path: preview(change.path) }] : []);
      return { ...base, itemType: "file_change", data: { path: preview(item.fileName), item: changes.length > 0 ? { changes } : {} } };
    }
    case "file_search":
      return { ...base, itemType: "dynamic_tool_call", data: { kind: "search", path: preview(item.pattern) } };
    case "web_search":
      return { ...base, itemType: "web_search", data: {} };
    case "subagent":
      return { ...base, itemType: "collab_agent_tool_call", data: { item: {} } };
    case "dynamic_tool":
      return typeof item.viewedImagePath === "string"
        ? { ...base, itemType: "image_view", data: { path: preview(item.viewedImagePath) } }
        : { ...base, itemType: "mcp_tool_call", data: { toolName: preview(item.toolName) } };
    default:
      return { ...base, itemType: "unknown", data: {} };
  }
}

function itemActivities(items: readonly unknown[]): T3ThreadActivity[] {
  const activities: (T3ThreadActivity & { readonly id: string })[] = [];
  for (const item of items) {
    if (!record(item) || typeof item.id !== "string" || typeof item.type !== "string") continue;
    const turnId = nonEmpty(item.runId);
    const id = activityId(item.id);
    if (item.type === "reasoning") {
      const at = nonEmpty(item.updatedAt) ?? nonEmpty(item.startedAt);
      if (at !== null) activities.push({ id: `${id}:progress`, kind: "task.progress", turnId, createdAt: at, payload: {} });
      continue;
    }
    if (!TOOL_ITEM_TYPES.has(item.type)) continue;
    const payload = toolPayload(item);
    const startedAt = nonEmpty(item.startedAt) ?? nonEmpty(item.updatedAt);
    if (startedAt !== null) activities.push({ id: `${id}:started`, kind: "tool.started", turnId, createdAt: startedAt, payload });
    const status = string(item.status);
    if (status !== null && TERMINAL_ITEM_STATUSES.has(status)) {
      const completedAt = nonEmpty(item.completedAt) ?? nonEmpty(item.updatedAt);
      if (completedAt !== null) {
        activities.push({ id, kind: "tool.completed", turnId, createdAt: completedAt, payload: { ...payload, status } });
      }
    }
  }
  return activities;
}

/**
 * Provider turn usage as V1 context-window activities. `usedTokens` is context
 * occupancy. V2 has no cumulative counter, so the lifetime total is the sum of
 * per-turn usage, and only while every earlier turn reported complete usage.
 * A bounded snapshot lacks older turns, so its total is unknown.
 */
function tokenActivities(providerTurns: readonly unknown[], nodes: ReadonlyMap<string, string | null>, partialHistory: boolean): T3ThreadActivity[] {
  const turns = providerTurns.filter(record).map((turn) => ({
    turn,
    at: nonEmpty(turn.startedAt) ?? nonEmpty(record(turn.tokenUsage) ? turn.tokenUsage.updatedAt : null) ?? "",
  })).sort((left, right) => left.at.localeCompare(right.at) || Number(left.turn.ordinal ?? 0) - Number(right.turn.ordinal ?? 0));
  const activities: T3ThreadActivity[] = [];
  let total: number | null = partialHistory ? null : 0;
  for (const { turn } of turns) {
    const usage = record(turn.turnTokenUsage) ? turn.turnTokenUsage : null;
    const input = count(usage?.inputTokens);
    const output = count(usage?.outputTokens);
    total = total !== null && usage?.usageStatus === "complete" && input !== null && output !== null
      ? total + input + output : null;
    const snapshot = record(turn.tokenUsage) ? turn.tokenUsage : null;
    const used = count(snapshot?.usedTokens);
    const at = nonEmpty(snapshot?.updatedAt);
    if (snapshot === null || used === null || at === null) continue;
    activities.push({
      kind: "context-window.updated",
      turnId: nodes.get(String(turn.nodeId)) ?? null,
      createdAt: at,
      payload: {
        usedTokens: used,
        ...(count(snapshot.maxTokens) === null ? {} : { maxTokens: snapshot.maxTokens }),
        ...(total === null ? {} : { totalProcessedTokens: total }),
      },
    });
  }
  return activities;
}

function runtimeRequestActivities(requests: readonly unknown[], items: readonly unknown[], nodes: ReadonlyMap<string, string | null>): T3ThreadActivity[] {
  const questions = new Map<string, Json>();
  for (const item of items) {
    if (record(item) && item.type === "user_input_request" && typeof item.requestId === "string") questions.set(item.requestId, item);
  }
  const activities: T3ThreadActivity[] = [];
  for (const request of requests) {
    if (!record(request) || typeof request.id !== "string") continue;
    const turnId = nodes.get(String(request.nodeId)) ?? null;
    if (request.kind === "user_input" && request.status === "pending") {
      const item = questions.get(request.id);
      if (item === undefined) continue;
      activities.push({ kind: "user-input.requested", turnId: nonEmpty(item.runId) ?? turnId,
        createdAt: request.createdAt, payload: { requestId: activityId(request.id), questions: item.questions } });
    } else if (request.kind !== "user_input" && request.status === "resolved" && typeof request.decision === "string") {
      activities.push({ id: activityId(request.id), kind: "approval.resolved", turnId,
        createdAt: request.resolvedAt ?? request.createdAt, payload: { decision: request.decision } } as T3ThreadActivity);
    }
  }
  return activities;
}

function proposedPlans(plans: readonly unknown[], items: readonly unknown[]): unknown[] {
  const planItems = new Map<string, Json>();
  for (const item of items) {
    if (record(item) && item.type === "proposed_plan" && typeof item.planId === "string") planItems.set(item.planId, item);
  }
  return plans.flatMap((plan) => {
    if (!record(plan) || plan.kind !== "proposed_plan" || typeof plan.id !== "string") return [];
    const item = planItems.get(plan.id);
    const updatedAt = nonEmpty(item?.updatedAt);
    if (item === undefined || updatedAt === null || item.streaming === true) return [];
    // T3 marks a plan actionable while it is active; implementation supersedes or completes it.
    return [{
      id: plan.id,
      turnId: plan.runId ?? null,
      planMarkdown: plan.markdown,
      createdAt: nonEmpty(item.startedAt) ?? updatedAt,
      updatedAt,
      implementedAt: plan.status === "active" ? null : updatedAt,
      implementationThreadId: null,
    }];
  });
}

function messageFromV2(value: unknown): (T3Message & { readonly attachments: readonly unknown[] }) | null {
  if (!record(value)) return null;
  const id = nonEmpty(value.id);
  const role = value.role === "user" || value.role === "assistant" || value.role === "system" ? value.role : null;
  const createdAt = nonEmpty(value.createdAt);
  if (id === null || role === null || createdAt === null || typeof value.text !== "string") return null;
  return {
    id, role, text: value.text,
    turnId: nonEmpty(value.runId),
    streaming: value.streaming === true,
    createdAt,
    updatedAt: nonEmpty(value.updatedAt) ?? createdAt,
    attachments: array(value.attachments),
  };
}

/**
 * Maps a full (`/threads/:id`) or bounded (`/threads/:id/bounded`) detail
 * snapshot. A bounded snapshot holds the recent runs and all live control
 * state; with `hasMoreHistory` it is not the complete conversation.
 */
export function threadFromV2(value: unknown): T3ThreadSnapshot {
  if (!record(value) || !Number.isSafeInteger(value.snapshotSequence) || !record(value.projection)) {
    throw new V2ShapeError("Invalid thread snapshot");
  }
  const projection = value.projection;
  if (!record(projection.thread) || !Array.isArray(projection.messages) || !Array.isArray(projection.runs)) {
    throw new V2ShapeError("Invalid thread projection");
  }
  const base = baseThread(projection.thread);
  const runs = projection.runs.map(runFromProjection).filter((run) => run !== null);
  const latestRun = runs.filter((run) => !(run.status === "queued" && run.queueHeld))
    .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const items = array(projection.turnItems);
  const requests = array(projection.runtimeRequests);
  const nodes = new Map(array(projection.nodes).flatMap((node) => record(node) && typeof node.id === "string"
    ? [[node.id, nonEmpty(node.runId)] as const] : []));
  const messages = projection.messages.map(messageFromV2).filter((message) => message !== null);
  const userTimes = messages.filter((message) => message.role === "user").map((message) => message.updatedAt).sort();
  const runningSubagents = latestRun !== null && items.some((item) => record(item) && item.type === "subagent" &&
    item.runId === latestRun.id && (item.status === "running" || item.status === "pending" || item.status === "waiting"));
  const thread: T3Thread = {
    ...base,
    latestUserMessageAt: userTimes.at(-1) ?? null,
    hasPendingUserInput: requests.some((request) => record(request) && request.kind === "user_input" && request.status === "pending"),
    ...(runningSubagents && turnState(latestRun.status) !== "running" ? { backgroundLiveness: "working" } : {}),
    ...runState(latestRun, base.updatedAt),
    messages,
    activities: [
      ...itemActivities(items),
      ...tokenActivities(array(projection.providerTurns), nodes, value.hasMoreHistory === true),
      ...runtimeRequestActivities(requests, items, nodes),
    ],
    proposedPlans: proposedPlans(array(projection.plans), items),
  };
  return { snapshotSequence: value.snapshotSequence as number, thread };
}

/**
 * Resolves the bridge-facing request id to T3's own id and the option values
 * T3 expects as answers (values fall back to labels). V2 request ids can
 * exceed the bridge's id limits, so long ids travel as a stable hash alias.
 */
export function pendingUserInput(value: unknown, requestId: string): {
  readonly requestId: string;
  readonly optionValues: ReadonlyMap<string, ReadonlyMap<string, string>>;
} | null {
  if (!record(value) || !record(value.projection)) return null;
  const item = array(value.projection.turnItems).find((candidate) => record(candidate) &&
    candidate.type === "user_input_request" && typeof candidate.requestId === "string" &&
    (candidate.requestId === requestId || activityId(candidate.requestId) === requestId));
  if (!record(item) || typeof item.requestId !== "string") return null;
  return { requestId: item.requestId, optionValues: userInputOptionValues(item) };
}

function userInputOptionValues(item: Json): ReadonlyMap<string, ReadonlyMap<string, string>> {
  return new Map(array(item.questions).flatMap((question) => record(question) && typeof question.id === "string"
    ? [[question.id, new Map(array(question.options).flatMap((option) => record(option) && typeof option.label === "string"
        ? [[option.label, typeof option.value === "string" ? option.value : option.label] as const] : []))] as const]
    : []));
}
