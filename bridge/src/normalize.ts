import { normalizeTokenUsage } from "./token-usage.js";
import { normalizePendingProposedPlan } from "./session-controls.js";
import { ApiError, isSafeId } from "./security.js";
import { normalizePendingPlanInput } from "./plan-input.js";
import type {
  BridgeEnvironment,
  BridgeConfig,
  T3Message,
  T3LiveActivity,
  T3LiveToolActivity,
  T3Project,
  T3ShellSnapshot,
  T3Thread,
  T3ThreadShell,
  T3ThreadSnapshot,
} from "./types.js";

type EnvironmentIdentity = Pick<BridgeEnvironment, "environmentId" | "label">;
const environmentFields = (environment?: EnvironmentIdentity) => environment
  ? { environmentId: environment.environmentId, environmentLabel: environment.label }
  : {};

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function latestIso(...values: readonly (string | null | undefined)[]): string {
  let latestValue = values.find((value): value is string => typeof value === "string") ?? "";
  let latest = validTime(latestValue) ?? Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const time = validTime(value);
    if (value !== null && value !== undefined && time !== null && time > latest) {
      latest = time;
      latestValue = value;
    }
  }
  return latestValue;
}

function activityAt(thread: T3ThreadShell): string {
  // Settlement, renaming and provider status updates are not new messages.
  // Prefer the latest conversation turn; use thread time only for empty or
  // legacy threads whose shell has no conversation timestamps.
  const conversationAt = latestIso(
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  );
  return validTime(conversationAt) !== null ? conversationAt : thread.updatedAt;
}

function compareActivity(left: T3ThreadShell, right: T3ThreadShell): number {
  const time = (validTime(activityAt(right)) ?? 0) - (validTime(activityAt(left)) ?? 0);
  return time !== 0 ? time : left.id.localeCompare(right.id);
}

function projectAllowed(projectId: string, config: BridgeConfig): boolean {
  return config.projectIds === null || config.projectIds.has(projectId);
}

export function findProject(
  snapshot: T3ShellSnapshot,
  projectId: string,
  config: BridgeConfig,
): T3Project {
  const project = snapshot.projects.find(
    (candidate) =>
      candidate.id === projectId &&
      candidate.deletedAt == null &&
      projectAllowed(candidate.id, config),
  );
  if (project === undefined) throw new ApiError(404, "not_found", "Project not found");
  return project;
}

export function findThread(
  snapshot: T3ShellSnapshot,
  threadId: string,
  config: BridgeConfig,
): T3ThreadShell {
  const thread = snapshot.threads.find(
    (candidate) => candidate.id === threadId && projectAllowed(candidate.projectId, config),
  );
  if (thread === undefined || thread.archivedAt !== null) {
    throw new ApiError(404, "not_found", "Session not found");
  }
  return thread;
}

export function normalizeProjects(snapshot: T3ShellSnapshot, config: BridgeConfig, environment?: EnvironmentIdentity) {
  const interactedAt = new Map<string, number>();
  for (const thread of snapshot.threads) {
    // User activity, not assistant completion or project metadata edits, determines recency.
    const at = validTime(latestIso(thread.latestUserMessageAt, thread.latestTurn?.requestedAt))
      ?? validTime(thread.createdAt) ?? 0;
    interactedAt.set(thread.projectId, Math.max(interactedAt.get(thread.projectId) ?? 0, at));
  }
  return snapshot.projects
    .filter((project) => project.deletedAt == null && projectAllowed(project.id, config))
    .map((project) => ({
      ...environmentFields(environment),
      id: project.id,
      title: project.title,
      canStartSession: true,
      updatedAt: project.updatedAt,
    }))
    .sort((left, right) => (interactedAt.get(right.id) ?? 0) - (interactedAt.get(left.id) ?? 0)
      || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

export function completedTurn(thread: T3ThreadShell): { id: string; completedAt: string } | null {
  const turn = thread.latestTurn;
  if (turn?.state !== "completed" || typeof turn.turnId !== "string" || !isSafeId(turn.turnId) ||
      typeof turn.completedAt !== "string" || turn.completedAt.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(turn.completedAt)) return null;
  const time = validTime(turn.completedAt);
  if (time === null) return null;
  const iso = new Date(time).toISOString();
  // T3 emits UTC ISO timestamps. Reject calendar rollover and ambiguous dates.
  if (turn.completedAt !== iso && turn.completedAt !== iso.replace(".000Z", "Z")) return null;
  return { id: turn.turnId, completedAt: iso };
}

export type SessionBackground = "subagents" | "monitoring";

/** Work T3 keeps running after the turn settles. Unknown values are ignored. */
export function sessionBackground(thread: T3ThreadShell): SessionBackground | null {
  if (thread.backgroundLiveness === "working") return "subagents";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return null;
}

function waitingOnUser(thread: T3ThreadShell): boolean {
  return thread.hasPendingUserInput === true && thread.latestTurn?.state === "running";
}

function sessionSummary(thread: T3ThreadShell, projects: ReadonlyMap<string, T3Project>, environment?: EnvironmentIdentity) {
  return {
    ...environmentFields(environment),
    id: thread.id,
    projectId: thread.projectId,
    projectTitle: projects.get(thread.projectId)?.title ?? "Unknown project",
    title: thread.title,
    status: thread.session?.status ?? "idle",
    lastActivityAt: activityAt(thread),
    settled: thread.settledOverride === "settled",
    completedTurn: completedTurn(thread),
    hasPendingUserInput: waitingOnUser(thread),
    background: sessionBackground(thread),
  };
}

/** T3's sidebar keeps this many of the newest settled threads; it pages older ones on demand. */
export const RECENT_SETTLED_LIMIT = 25;

/** The newest settled threads by settle time, ties at the cut included, as T3 keeps them. */
function recentSettled(threads: readonly T3ThreadShell[]): T3ThreadShell[] {
  const settledAt = (thread: T3ThreadShell) => validTime(thread.settledAt);
  const times = threads.map(settledAt).filter((time): time is number => time !== null).sort((left, right) => right - left);
  const cut = times[RECENT_SETTLED_LIMIT - 1] ?? -Infinity;
  // A missing or unreadable settle time is never counted as older, matching T3.
  return threads.filter((thread) => (settledAt(thread) ?? Infinity) >= cut);
}

export function normalizeSessions(snapshot: T3ShellSnapshot, config: BridgeConfig, environment?: EnvironmentIdentity) {
  const projects = new Map(
    snapshot.projects
      .filter((project) => project.deletedAt == null && projectAllowed(project.id, config))
      .map((project) => [project.id, project] as const),
  );
  // Subagent children never settle, so they would pile up. Show one only while it waits on the user.
  const visible = snapshot.threads.filter(
    (thread) => thread.archivedAt === null && projects.has(thread.projectId) &&
      (thread.subagent !== true || waitingOnUser(thread)),
  );
  const unsettled = visible
    .filter((thread) => thread.settledOverride !== "settled")
    .sort(compareActivity)
    .map((thread) => sessionSummary(thread, projects, environment));
  const settled = recentSettled(visible.filter((thread) => thread.settledOverride === "settled"))
    .sort(compareActivity)
    .map((thread) => sessionSummary(thread, projects, environment));
  return {
    snapshotId: String(snapshot.snapshotSequence),
    frozenAt: snapshot.updatedAt,
    unsettled,
    settled,
  };
}

interface TranscriptTurn {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  separatorLabel: string;
  messages: Array<{
    id: string;
    role: T3Message["role"];
    text: string;
    streaming: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `WORKED ${seconds}S`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `WORKED ${minutes}M` : `WORKED ${minutes}M ${remainder}S`;
}

const LIVE_ACTIVITY_PRESENTATION: Readonly<
  Record<string, Pick<T3LiveActivity, "phase" | "label">>
> = {
  "task.started": { phase: "thinking", label: "Thinking" },
  "task.updated": { phase: "thinking", label: "Thinking" },
  "task.progress": { phase: "thinking", label: "Thinking" },
  "tool.started": { phase: "tool", label: "Using a tool" },
  "tool.completed": { phase: "thinking", label: "Thinking" },
  "checkpoint.captured": { phase: "thinking", label: "Thinking" },
  "context-window.updated": { phase: "thinking", label: "Thinking" },
};

const MAX_LIVE_TOOL_ACTIVITIES = 32;
const MAX_LIVE_TOOL_LABEL_CHARS = 120;
const MAX_SOURCE_PREVIEW_CHARS = 2048;

function canonicalIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = validTime(value);
  return time === null ? null : new Date(time).toISOString();
}

function activityCorrelation(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["toolCallId", "callId"] as const) {
    const value = record[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 200 &&
      /^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      return value;
    }
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 3)).trimEnd()}...`;
}

function oneLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .slice(0, MAX_SOURCE_PREVIEW_CHARS)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

const SENSITIVE_NAME =
  "(?:api[-_]?key|token|auth(?:orization)?|bearer|password|passwd|passphrase|secret|credential|private[-_]?key|cookie|session[-_]?id)";
const SENSITIVE_ASSIGNMENT = new RegExp(
  `(?:--)?${SENSITIVE_NAME}(?:\\s+|\\s*=\\s*|\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^\\s;&|,]+)`,
  "giu",
);
const SENSITIVE_QUERY = new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s]+`, "giu");
const SENSITIVE_WORD_TOKEN = new RegExp(
  `[A-Za-z0-9_./:=+-]*${SENSITIVE_NAME}[A-Za-z0-9_./:=+-]*`,
  "giu",
);

function redactPreview(value: string): string {
  let redacted = value
    .replace(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s"']+/giu, "Authorization: [redacted]")
    // Environment assignments can carry arbitrary values, so redact every one,
    // not only names that look sensitive.
    .replace(
      /(^|[\s;&|"'`([{])([A-Za-z_][A-Za-z0-9_]{0,63})=(?:"[^"]*"|'[^']*'|[^\s;&|"'`\])}]*)/gu,
      "$1$2=[redacted]",
    )
    .replace(SENSITIVE_ASSIGNMENT, (match) => {
      const separator = /(?:\s*=\s*|\s*:\s*|\s+)/u.exec(match);
      return `${separator === null ? "" : match.slice(0, separator.index + separator[0].length)}[redacted]`;
    })
    .replace(SENSITIVE_QUERY, "$1[redacted]")
    .replace(/(\bhttps?:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, (match) => {
      const scheme = match.slice(0, match.indexOf(" "));
      return `${scheme} [redacted]`;
    })
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu,
      "[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{32,}/gu, (candidate) => {
      if (/^[a-f0-9]+$/iu.test(candidate)) return candidate;
      return /[A-Za-z]/u.test(candidate) && /[0-9]/u.test(candidate)
        ? "[redacted]"
        : candidate;
    });
  // This catches sensitive environment names or bare secret-like values that
  // were not expressed as an assignment or option.
  redacted = redacted.replace(SENSITIVE_WORD_TOKEN, "[redacted]");
  return redacted.replace(/(?:\[redacted\]){2,}/gu, "[redacted]").replace(/\s+/gu, " ").trim();
}

function commandValue(data: Record<string, unknown> | null): string | null {
  const item = recordOf(data?.item);
  for (const candidate of [item?.command, recordOf(item?.input)?.command, data?.command]) {
    const direct = oneLine(candidate);
    if (direct !== null) return direct;
    if (Array.isArray(candidate)) {
      const parts = candidate
        .slice(0, 32)
        .map((part) => oneLine(part))
        .filter((part): part is string => part !== null);
      if (parts.length > 0) return boundedText(parts.join(" "), MAX_SOURCE_PREVIEW_CHARS);
    }
  }
  return null;
}

function safePath(value: unknown): string | null {
  const path = oneLine(value);
  if (path === null) return null;
  const redacted = redactPreview(path);
  return redacted.length === 0 ? null : boundedText(redacted, 96);
}

function safeToolName(value: unknown): string | null {
  const name = oneLine(value);
  if (
    name === null ||
    name.length > 64 ||
    !/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(name) ||
    new RegExp(SENSITIVE_NAME, "iu").test(name) ||
    /[A-Za-z0-9_-]{32,}/u.test(name)
  ) {
    return null;
  }
  return name;
}

function firstStructuredPath(data: Record<string, unknown> | null): string | null {
  const item = recordOf(data?.item);
  const changes = item?.changes;
  if (Array.isArray(changes)) {
    for (const change of changes.slice(0, 32)) {
      const path = safePath(recordOf(change)?.path);
      if (path !== null) return path;
    }
  }
  const rawInput = recordOf(data?.rawInput);
  for (const candidate of [
    item?.path,
    rawInput?.target_file,
    rawInput?.path,
    data?.path,
    data?.filePath,
  ]) {
    const path = safePath(candidate);
    if (path !== null) return path;
  }
  return null;
}

function finishToolLabel(prefix: string, detail: string | null): string {
  return boundedText(detail === null ? prefix : `${prefix} ${detail}`, MAX_LIVE_TOOL_LABEL_CHARS);
}

const GENERIC_TOOL_LABELS = new Set([
  "tool call",
  "ran command",
  "read file",
  "changed files",
  "searched files",
  "used MCP tool",
  "used tool",
  "agent task",
  "searched web",
  "viewed image",
]);

function richerToolLabel(started: string, completed: string): string {
  return !GENERIC_TOOL_LABELS.has(completed) || GENERIC_TOOL_LABELS.has(started)
    ? completed
    : started;
}

function liveToolLabel(payload: unknown): string {
  const record = recordOf(payload);
  if (record === null) return "tool call";
  const data = recordOf(record.data);
  const item = recordOf(data?.item);
  const itemType = record.itemType;
  const structuredPath = firstStructuredPath(data);
  switch (itemType) {
    case "command_execution": {
      const command = commandValue(data);
      return finishToolLabel("ran", command === null ? "command" : redactPreview(command));
    }
    case "file_change": {
      const changes = item?.changes;
      const extra = Array.isArray(changes) && changes.length > 1
        ? ` +${Math.min(changes.length - 1, 99)}`
        : "";
      return finishToolLabel("changed", structuredPath === null ? "files" : `${structuredPath}${extra}`);
    }
    case "collab_agent_tool_call": {
      const toolName = safeToolName(item?.tool);
      return toolName === null ? "agent task" : finishToolLabel("agent", toolName);
    }
    case "web_search":
      return "searched web";
    case "image_view":
      return finishToolLabel("viewed", structuredPath === null ? "image" : structuredPath);
    case "mcp_tool_call": {
      const toolName = safeToolName(item?.tool) ?? safeToolName(data?.toolName);
      return toolName === null ? "used MCP tool" : finishToolLabel("called", toolName);
    }
    case "dynamic_tool_call": {
      const kind = data?.kind;
      if (kind === "execute") {
        const command = commandValue(data);
        return finishToolLabel("ran", command === null ? "command" : redactPreview(command));
      }
      if (kind === "read") return finishToolLabel("read", structuredPath === null ? "file" : structuredPath);
      if (kind === "edit" || kind === "write" || kind === "move" || kind === "delete") {
        return finishToolLabel("changed", structuredPath === null ? "files" : structuredPath);
      }
      if (kind === "search" || kind === "find" || kind === "grep") {
        return finishToolLabel("searched", structuredPath === null ? "files" : structuredPath);
      }
      const toolName = safeToolName(recordOf(data?.rawInput)?.tool_name);
      return toolName === null ? "used tool" : finishToolLabel("called", toolName);
    }
    default:
      return "tool call";
  }
}

function normalizeLiveActivity(thread: T3Thread): T3LiveActivity | null {
  const latestTurn = thread.latestTurn;
  const session = thread.session;
  if (
    latestTurn?.state !== "running" ||
    session?.status !== "running" ||
    session.activeTurnId !== latestTurn.turnId
  ) {
    return null;
  }

  let latest:
    | { readonly presentation: Pick<T3LiveActivity, "phase" | "label">; readonly time: number }
    | null = null;
  if (Array.isArray(thread.activities)) {
    for (const activity of thread.activities) {
      if (
        typeof activity !== "object" ||
        activity === null ||
        activity.turnId !== latestTurn.turnId ||
        typeof activity.kind !== "string"
      ) {
        continue;
      }
      const presentation = LIVE_ACTIVITY_PRESENTATION[activity.kind];
      const time = typeof activity.createdAt === "string" ? validTime(activity.createdAt) : null;
      if (presentation !== undefined && time !== null && (latest === null || time > latest.time)) {
        latest = { presentation, time };
      }
    }
  }

  if (latest !== null) {
    return {
      ...latest.presentation,
      updatedAt: new Date(latest.time).toISOString(),
    };
  }

  const updatedAt =
    canonicalIso(latestTurn.startedAt) ??
    canonicalIso(session.updatedAt) ??
    canonicalIso(thread.updatedAt);
  return updatedAt === null ? null : { phase: "thinking", label: "Thinking", updatedAt };
}

function normalizeLiveToolActivities(thread: T3Thread): T3LiveToolActivity[] {
  const latestTurn = thread.latestTurn;
  const session = thread.session;
  if (
    latestTurn?.state !== "running" ||
    session?.status !== "running" ||
    session.activeTurnId !== latestTurn.turnId ||
    !Array.isArray(thread.activities)
  ) {
    return [];
  }

  const events = thread.activities.flatMap((activity, sourceIndex) => {
    if (
      typeof activity !== "object" ||
      activity === null ||
      activity.turnId !== latestTurn.turnId ||
      (activity.kind !== "tool.started" && activity.kind !== "tool.completed")
    ) {
      return [];
    }
    const at = canonicalIso(activity.createdAt);
    return at === null
      ? []
      : [{
          kind: activity.kind,
          at,
          sourceIndex,
          correlation: activityCorrelation(activity.payload),
          label: liveToolLabel(activity.payload),
        }];
  });
  events.sort((left, right) => {
    const time = Date.parse(left.at) - Date.parse(right.at);
    return time !== 0 ? time : left.sourceIndex - right.sourceIndex;
  });

  const tools: T3LiveToolActivity[] = [];
  const open: number[] = [];
  const openByCorrelation = new Map<string, number>();
  const ambiguousCorrelations = new Set<string>();
  const startsAtTimestamp = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "tool.started") {
      const timestampOrdinal = startsAtTimestamp.get(event.at) ?? 0;
      startsAtTimestamp.set(event.at, timestampOrdinal + 1);
      tools.push({
        id: `tool:${event.at}:${timestampOrdinal}`,
        kind: "tool",
        label: event.label,
        startedAt: event.at,
        completedAt: null,
      });
      open.push(tools.length - 1);
      if (event.correlation !== null) {
        if (openByCorrelation.has(event.correlation)) {
          openByCorrelation.delete(event.correlation);
          ambiguousCorrelations.add(event.correlation);
        } else if (!ambiguousCorrelations.has(event.correlation)) {
          openByCorrelation.set(event.correlation, tools.length - 1);
        }
      }
      continue;
    }
    const correlatedIndex =
      event.correlation === null || ambiguousCorrelations.has(event.correlation)
        ? undefined
        : openByCorrelation.get(event.correlation);
    const openIndex = correlatedIndex ?? (open.length === 1 ? open[0] : undefined);
    if (openIndex === undefined) continue;
    const started = tools[openIndex];
    if (started === undefined) continue;
    tools[openIndex] = {
      ...started,
      label: richerToolLabel(started.label, event.label),
      completedAt: event.at,
    };
    open.splice(open.indexOf(openIndex), 1);
    if (event.correlation !== null) openByCorrelation.delete(event.correlation);
    for (const [correlation, index] of openByCorrelation) {
      if (index === openIndex) openByCorrelation.delete(correlation);
    }
  }

  return tools.slice(-MAX_LIVE_TOOL_ACTIVITIES);
}

function authoritativeAssistantMessageId(thread: T3Thread): string | null {
  const latestTurn = thread.latestTurn;
  if (
    latestTurn === null ||
    latestTurn.state !== "completed" ||
    typeof latestTurn.assistantMessageId !== "string" ||
    latestTurn.assistantMessageId.length === 0 ||
    latestTurn.assistantMessageId.length > 200 ||
    latestTurn.assistantMessageId.trim() !== latestTurn.assistantMessageId
  ) {
    return null;
  }
  const candidate = thread.messages.find(
    (message) =>
      message.id === latestTurn.assistantMessageId &&
      message.role === "assistant" &&
      message.turnId === latestTurn.turnId,
  );
  return candidate?.id ?? null;
}

function transcriptMessages(thread: T3Thread): readonly T3Message[] {
  const assistantMessageId = authoritativeAssistantMessageId(thread);
  const latestTurnId = thread.latestTurn?.turnId;
  if (assistantMessageId === null || typeof latestTurnId !== "string") return thread.messages;
  return thread.messages.filter(
    (message) =>
      message.role !== "assistant" ||
      message.turnId !== latestTurnId ||
      message.id === assistantMessageId,
  );
}

function normalizeTranscriptThread(thread: T3Thread): TranscriptTurn[] {
  const ordered = [...transcriptMessages(thread)].sort((left, right) => {
    const time = (validTime(left.createdAt) ?? 0) - (validTime(right.createdAt) ?? 0);
    return time !== 0 ? time : left.id.localeCompare(right.id);
  });
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const message of ordered) {
    if (message.role === "user" || current === null) {
      current = {
        id: message.turnId ?? `message:${message.id}`,
        startedAt: message.createdAt,
        endedAt: message.updatedAt,
        durationSeconds: 0,
        separatorLabel: "WORKED 0S",
        messages: [],
      };
      turns.push(current);
    } else if (message.role === "assistant" && message.turnId !== null) {
      const first = current.messages[0];
      if (first?.role === "user" && current.id.startsWith("message:")) {
        current.id = message.turnId;
      }
    }
    current.messages.push({
      id: message.id,
      role: message.role,
      text: message.text,
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    });
    if ((validTime(message.updatedAt) ?? 0) > (validTime(current.endedAt) ?? 0)) {
      current.endedAt = message.updatedAt;
    }
  }
  for (const turn of turns) {
    turn.durationSeconds = Math.max(
      0,
      Math.round(((validTime(turn.endedAt) ?? 0) - (validTime(turn.startedAt) ?? 0)) / 1000),
    );
    turn.separatorLabel = formatDuration(turn.durationSeconds);
  }
  return turns;
}

function normalizeSessionSettings(thread: T3ThreadShell): { interactionMode?: "default" | "plan"; modelSelection?: { instanceId: string; model: string; reasoningId?: string } } {
  const bounded = (value: unknown, max: number): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
  const selection = thread.modelSelection;
  const mode = thread.interactionMode === "default" || thread.interactionMode === "plan" ? thread.interactionMode : undefined;
  if (!selection || !bounded(selection.instanceId, 128) || !bounded(selection.model, 256)) {
    return mode === undefined ? {} : { interactionMode: mode };
  }
  const reasoning = Array.isArray(selection.options) && selection.options.length <= 64
    ? selection.options.find((option) => option && ["reasoningEffort", "effort"].includes(option.id) && bounded(option.value, 128))?.value : undefined;
  return { ...(mode === undefined ? {} : { interactionMode: mode }),
    modelSelection: { instanceId: selection.instanceId, model: selection.model,
      ...(typeof reasoning === "string" ? { reasoningId: reasoning } : {}) } };
}

export function normalizeTranscript(snapshot: T3ThreadSnapshot, projectTitle = "Unknown project", environment?: EnvironmentIdentity) {
  return {
    ...environmentFields(environment),
    snapshotId: String(snapshot.snapshotSequence),
    session: {
      ...environmentFields(environment),
      id: snapshot.thread.id,
      projectId: snapshot.thread.projectId,
      projectTitle,
      title: snapshot.thread.title,
      status: snapshot.thread.session?.status ?? "idle",
      lastActivityAt: activityAt(snapshot.thread),
      settled: snapshot.thread.settledOverride === "settled",
      completedTurn: completedTurn(snapshot.thread),
      hasPendingUserInput: snapshot.thread.hasPendingUserInput === true && snapshot.thread.latestTurn?.state === "running",
      background: sessionBackground(snapshot.thread),
      ...normalizeSessionSettings(snapshot.thread),
    },
    tokenUsage: normalizeTokenUsage(snapshot.thread.activities),
    liveActivity: normalizeLiveActivity(snapshot.thread),
    liveActivities: normalizeLiveToolActivities(snapshot.thread),
    pendingPlanInput: normalizePendingPlanInput(snapshot.thread),
    pendingProposedPlan: normalizePendingProposedPlan(snapshot.thread),
    turns: normalizeTranscriptThread(snapshot.thread),
  };
}
