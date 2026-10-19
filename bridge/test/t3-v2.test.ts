import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSessions, normalizeTranscript } from "../src/normalize.js";
import { normalizePendingPlanInput } from "../src/plan-input.js";
import { normalizePendingProposedPlan, requireIdleSession } from "../src/session-controls.js";
import { pendingUserInput, shellFromV2, threadFromV2, V2ShapeError } from "../src/t3-v2.js";
import type { BridgeConfig } from "../src/types.js";

const config = { projectIds: null } as unknown as BridgeConfig;
const RUN_1 = "run:thread:thread-1:ordinal:1";
const RUN_2 = "run:thread:thread-1:ordinal:2";
const NODE_2 = "node:run:run%3Athread%3Athread-1%3Aordinal%3A2:root";

const project = {
  id: "project-1", title: "Even Realities", workspaceRoot: "/repo", repositoryIdentity: null,
  defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" }, scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

function shellThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdBy: "user", creationSource: "web", id: "thread-1", projectId: "project-1", title: "Fixture",
    providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }] },
    runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
    latestRunId: null, latestRunRequestedAt: null, latestRunStartedAt: null, latestRunCompletedAt: null,
    activeRunId: null, activityRunStatus: null, status: "idle", pendingRuntimeRequest: null,
    latestUserMessageAt: null, hasActionableProposedPlan: false, pendingBackgroundTasks: [],
    createdAt: "2026-10-13T10:00:00.000Z", updatedAt: "2026-10-13T10:05:00.000Z", archivedAt: null,
    settledOverride: null, settledAt: null, unsettledAt: null,
    ...overrides,
  };
}

function run(id: string, ordinal: number, status: string, completedAt: string | null) {
  return { id, threadId: "thread-1", ordinal, status, requestedAt: `2026-10-13T10:0${ordinal}:00.000Z`,
    startedAt: `2026-10-13T10:0${ordinal}:01.000Z`, completedAt, queuePosition: null };
}

function item(type: string, fields: Record<string, unknown>) {
  return { threadId: "thread-1", runId: RUN_2, nodeId: NODE_2, providerThreadId: null, providerTurnId: null,
    nativeItemRef: null, parentItemId: null, ordinal: 1, status: "completed", title: null,
    startedAt: "2026-10-13T10:02:02.000Z", completedAt: "2026-10-13T10:02:03.000Z",
    updatedAt: "2026-10-13T10:02:03.000Z", type, ...fields };
}

function detail(extra: Record<string, unknown> = {}, thread: Record<string, unknown> = {}) {
  return {
    snapshotSequence: 9,
    projection: {
      thread: { ...shellThread(), ...thread },
      runs: [run(RUN_1, 1, "completed", "2026-10-13T10:01:30.000Z"), run(RUN_2, 2, "running", null)],
      attempts: [], nodes: [{ id: NODE_2, runId: RUN_2 }], subagents: [], providerSessions: [], providerThreads: [],
      providerTurns: [], runtimeRequests: [], plans: [], turnItems: [], checkpointScopes: [], checkpoints: [],
      contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], updatedAt: "2026-10-13T10:05:00.000Z",
      messages: [
        { id: "m-1", threadId: "thread-1", runId: RUN_1, nodeId: null, role: "user", text: "First", attachments: [],
          streaming: false, createdAt: "2026-10-13T10:01:00.000Z", updatedAt: "2026-10-13T10:01:00.000Z" },
        { id: "m-2", threadId: "thread-1", runId: RUN_1, nodeId: null, role: "assistant", text: "Done", attachments: [],
          streaming: false, createdAt: "2026-10-13T10:01:20.000Z", updatedAt: "2026-10-13T10:01:30.000Z" },
        { id: "m-3", threadId: "thread-1", runId: RUN_2, nodeId: null, role: "user", text: "Second", attachments: [],
          streaming: false, createdAt: "2026-10-13T10:02:00.000Z", updatedAt: "2026-10-13T10:02:00.000Z" },
      ],
      ...extra,
    },
  };
}

describe("T3 V2 shell adapter", () => {
  it("maps run state onto sessions, turns and completion", () => {
    const shell = shellFromV2({ schemaVersion: 2, snapshotSequence: 4, projects: [project], archivedThreads: [], threads: [
      shellThread({ id: "idle" }),
      shellThread({ id: "running", latestRunId: RUN_1, status: "running", activeRunId: RUN_1,
        latestRunRequestedAt: "2026-10-13T10:01:00.000Z", latestRunStartedAt: "2026-10-13T10:01:01.000Z" }),
      shellThread({ id: "waiting", latestRunId: RUN_1, status: "waiting", latestRunRequestedAt: "2026-10-13T10:01:00.000Z",
        pendingRuntimeRequest: { id: "request-1", kind: "user_input", createdAt: "2026-10-13T10:01:05.000Z" } }),
      shellThread({ id: "done", latestRunId: RUN_1, status: "completed", latestRunRequestedAt: "2026-10-13T10:01:00.000Z",
        latestRunStartedAt: "2026-10-13T10:01:01.000Z", latestRunCompletedAt: "2026-10-13T10:01:30.000Z",
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }, { taskId: "server", kind: "command" }] }),
      shellThread({ id: "shell-only", latestRunId: RUN_1, status: "completed", latestRunRequestedAt: "2026-10-13T10:01:00.000Z",
        latestRunCompletedAt: "2026-10-13T10:01:30.000Z", pendingBackgroundTasks: [{ taskId: "server", kind: "command" }] }),
      shellThread({ id: "opaque", latestRunId: RUN_1, status: "completed", latestRunRequestedAt: "2026-10-13T10:01:00.000Z",
        latestRunCompletedAt: "2026-10-13T10:01:30.000Z", pendingBackgroundTasks: [{ taskId: "t", kind: "background_task" }] }),
      shellThread({ id: "failed", latestRunId: RUN_1, status: "failed", latestRunRequestedAt: "2026-10-13T10:01:00.000Z",
        latestRunCompletedAt: "2026-10-13T10:01:30.000Z", pendingBackgroundTasks: [{ taskId: "a", kind: "subagent" }] }),
    ] });
    assert.equal(shell.snapshotSequence, 4);
    assert.equal(shell.updatedAt, "2026-10-13T10:05:00.000Z");
    const byId = new Map(normalizeSessions(shell, config).unsettled.map((session) => [session.id, session]));
    assert.equal(byId.get("idle")!.status, "idle");
    assert.equal(byId.get("running")!.status, "running");
    assert.equal(byId.get("waiting")!.status, "running");
    assert.equal(byId.get("waiting")!.hasPendingUserInput, true);
    assert.deepEqual(byId.get("done")!.completedTurn, { id: RUN_1, completedAt: "2026-10-13T10:01:30.000Z" });
    assert.equal(byId.get("done")!.status, "ready");
    assert.equal(byId.get("done")!.background, "monitoring");
    // A background shell command is not live work, matching T3's own thread status.
    assert.equal(byId.get("shell-only")!.background, null);
    assert.equal(byId.get("opaque")!.background, "subagents");
    assert.equal(byId.get("failed")!.status, "error");
    assert.equal(byId.get("failed")!.background, "subagents");
    const idle = shell.threads.find((thread) => thread.id === "done")!;
    assert.doesNotThrow(() => requireIdleSession(idle));
    assert.throws(() => requireIdleSession(shell.threads.find((thread) => thread.id === "running")!), { code: "session_busy" });
  });

  it("rejects structurally invalid shells", () => {
    assert.throws(() => shellFromV2({ snapshotSequence: 1, projects: [], threads: [{ id: "t" }] }), V2ShapeError);
    assert.throws(() => shellFromV2({ projects: [], threads: [] }), V2ShapeError);
  });
});

describe("T3 V2 thread adapter", () => {
  it("groups messages by run and exposes the running run's tools", () => {
    const snapshot = threadFromV2(detail({ turnItems: [
      item("command_execution", { id: "turn-item:cmd", input: "npm test", status: "completed" }),
      item("file_change", { id: "turn-item:native:a%3Ab", fileName: "src/app.ts", status: "running", completedAt: null,
        startedAt: "2026-10-13T10:02:04.000Z", changes: [{ operation: "edit", path: "src/app.ts" }, { operation: "add", path: "b.ts" }] }),
      item("dynamic_tool", { id: "turn-item:mcp", toolName: "html_render", input: {}, status: "failed",
        startedAt: "2026-10-13T10:02:05.000Z", completedAt: "2026-10-13T10:02:06.000Z" }),
      item("reasoning", { id: "turn-item:think", updatedAt: "2026-10-13T10:02:07.000Z" }),
    ] }));
    const transcript = normalizeTranscript(snapshot, "Even Realities");
    assert.deepEqual(transcript.turns.map((turn) => [turn.id, turn.messages.map((message) => message.id)]),
      [[RUN_1, ["m-1", "m-2"]], [RUN_2, ["m-3"]]]);
    assert.equal(transcript.session.status, "running");
    assert.deepEqual(transcript.liveActivities.map((tool) => [tool.label, tool.completedAt]), [
      ["ran npm test", "2026-10-13T10:02:03.000Z"],
      ["changed src/app.ts +1", null],
      ["called html_render", "2026-10-13T10:02:06.000Z"],
    ]);
    assert.deepEqual(transcript.liveActivity, { phase: "thinking", label: "Thinking", updatedAt: "2026-10-13T10:02:07.000Z" });
    const ids = (snapshot.thread.activities ?? []).map((activity) => String(activity.id));
    assert.equal(ids.every((id) => /^[A-Za-z0-9_.:-]{1,256}$/.test(id)), true);
  });

  it("reports context occupancy and a lifetime total only while every turn reported complete usage", () => {
    const usage = (usedTokens: number, at: string) => ({ usedTokens, maxTokens: 200_000, updatedAt: at });
    const complete = (inputTokens: number, outputTokens: number) => ({ usageScope: "main_agent", usageStatus: "complete",
      inputTokens, outputTokens, hasSubagents: false });
    const turns = [
      { id: "pt-1", nodeId: "n-1", ordinal: 1, status: "completed", startedAt: "2026-10-13T10:01:01.000Z",
        tokenUsage: usage(1000, "2026-10-13T10:01:30.000Z"), turnTokenUsage: complete(900, 100) },
      { id: "pt-2", nodeId: NODE_2, ordinal: 2, status: "running", startedAt: "2026-10-13T10:02:01.000Z",
        tokenUsage: usage(2500, "2026-10-13T10:02:30.000Z"), turnTokenUsage: complete(2000, 400) },
    ];
    assert.deepEqual(normalizeTranscript(threadFromV2(detail({ providerTurns: turns }))).tokenUsage, {
      contextTokens: 2500, contextWindowTokens: 200_000, totalTokens: 3400, latestTotalTokens: 3400,
      updatedAt: "2026-10-13T10:02:30.000Z" });
    const partial = [{ ...turns[0], turnTokenUsage: { usageScope: "main_agent", usageStatus: "partial", hasSubagents: false } }, turns[1]];
    const unknownTotal = normalizeTranscript(threadFromV2(detail({ providerTurns: partial }))).tokenUsage;
    assert.equal(unknownTotal.contextTokens, 2500);
    assert.equal(unknownTotal.totalTokens, null);
  });

  it("leaves the lifetime total unknown when a bounded snapshot omits older runs", () => {
    const turn = { id: "pt-2", nodeId: NODE_2, ordinal: 2, status: "running", startedAt: "2026-10-13T10:02:01.000Z",
      tokenUsage: { usedTokens: 2500, maxTokens: 200_000, updatedAt: "2026-10-13T10:02:30.000Z" },
      turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 2000, outputTokens: 400, hasSubagents: false } };
    const bounded = { ...detail({ providerTurns: [turn] }), historyCursor: "opaque", hasMoreHistory: true };
    const usage = normalizeTranscript(threadFromV2(bounded)).tokenUsage;
    assert.equal(usage.contextTokens, 2500);
    assert.equal(usage.totalTokens, null);
    assert.equal(normalizeTranscript(threadFromV2({ ...bounded, hasMoreHistory: false })).tokenUsage.totalTokens, 2400);
  });

  it("copies at most the label preview of long tool input", () => {
    const snapshot = threadFromV2(detail({ turnItems: [
      item("command_execution", { id: "turn-item:long", input: `echo ${"x".repeat(50_000)}`, status: "running", completedAt: null }),
    ] }));
    assert.ok(JSON.stringify(snapshot.thread.activities).length < 5000);
    assert.match(normalizeTranscript(snapshot).liveActivities[0]!.label, /^ran echo x+\.\.\.$/);
  });

  it("exposes a pending structured question for the running run", () => {
    const questions = [{ id: "scope", header: "Scope", question: "How much should change?",
      options: [{ label: "Small", description: "One file", value: "small" }, { label: "Large", description: "Refactor" }] }];
    const snapshot = detail({
      runs: [run(RUN_1, 1, "completed", "2026-10-13T10:01:30.000Z"), run(RUN_2, 2, "waiting", null)],
      runtimeRequests: [{ id: "request-1", nodeId: NODE_2, providerTurnId: null, nativeRequestRef: null, kind: "user_input",
        status: "pending", responseCapability: { type: "live", providerSessionId: "ps" },
        createdAt: "2026-10-13T10:02:10.000Z", resolvedAt: null }],
      turnItems: [item("user_input_request", { id: "turn-item:q", requestId: "request-1", status: "waiting", questions })],
    });
    const thread = threadFromV2(snapshot).thread;
    assert.equal(thread.hasPendingUserInput, true);
    const pending = normalizePendingPlanInput(thread);
    assert.equal(pending?.requestId, "request-1");
    assert.equal(pending?.turnId, RUN_2);
    assert.deepEqual(pending?.questions.map((question) => question.options.map((option) => option.label)), [["Small", "Large"]]);
    assert.deepEqual([...pendingUserInput(snapshot, "request-1")!.optionValues.get("scope")!], [["Small", "small"], ["Large", "Large"]]);
    assert.equal(pendingUserInput(snapshot, "other"), null);

    const resolved = structuredClone(snapshot);
    (resolved.projection.runtimeRequests as Record<string, unknown>[])[0]!.status = "resolved";
    assert.equal(normalizePendingPlanInput(threadFromV2(resolved).thread), null);
  });

  it("aliases provider request ids that exceed the bridge id limits and resolves them back", () => {
    const requestId = `runtime-request:provider:claudeAgent:provider-turn:${"turn%253Arun-attempt%253A".repeat(12)}:native-request:toolu_01`;
    assert.ok(requestId.length > 256);
    const questions = [{ id: "A long question used as its own id?", header: "Overlays", question: "A long question used as its own id?",
      multiSelect: true, options: [{ label: "Poke", description: "Tap to click" }, { label: "Pinch", description: "Pinch to drag" }] }];
    const snapshot = detail({
      runs: [run(RUN_1, 1, "completed", "2026-10-13T10:01:30.000Z"), run(RUN_2, 2, "running", null)],
      runtimeRequests: [{ id: requestId, nodeId: "node:runtime-request:x", providerTurnId: null, nativeRequestRef: null, kind: "user_input",
        status: "pending", responseCapability: { type: "live", providerSessionId: "ps" },
        createdAt: "2026-10-13T10:02:10.000Z", resolvedAt: null }],
      turnItems: [
        item("dynamic_tool", { id: "turn-item:ask", toolName: "AskUserQuestion", input: { questions }, status: "running", completedAt: null }),
        item("user_input_request", { id: "turn-item:q", requestId, status: "waiting", questions }),
      ],
    });
    const pending = normalizePendingPlanInput(threadFromV2(snapshot).thread);
    assert.match(pending!.requestId, /^v2:[a-f0-9]{40}$/);
    assert.equal(pending!.questions[0]!.multiSelect, true);
    assert.equal(pendingUserInput(snapshot, pending!.requestId)!.requestId, requestId);
    assert.equal(pendingUserInput(snapshot, requestId)!.requestId, requestId);
  });

  it("offers only an active proposed plan from the latest completed run", () => {
    const planItem = item("proposed_plan", { id: "turn-item:plan", planId: "plan-1", markdown: "Do it", streaming: false });
    const snapshot = (status: string) => detail({
      runs: [run(RUN_1, 1, "completed", "2026-10-13T10:01:30.000Z"), run(RUN_2, 2, "completed", "2026-10-13T10:02:30.000Z")],
      plans: [{ id: "plan-1", threadId: "thread-1", runId: RUN_2, nodeId: NODE_2, status, kind: "proposed_plan", markdown: "Do it" }],
      turnItems: [planItem],
    }, { interactionMode: "plan" });
    const plan = normalizePendingProposedPlan(threadFromV2(snapshot("active")).thread);
    assert.equal(plan?.planId, "plan-1");
    assert.equal(plan?.turnId, RUN_2);
    assert.equal(plan?.planMarkdown, "Do it");
    for (const status of ["completed", "superseded"]) {
      assert.equal(normalizePendingProposedPlan(threadFromV2(snapshot(status)).thread), null);
    }
  });

  it("records resolved approvals and finished tools for the archive with safe ids", () => {
    const snapshot = threadFromV2(detail({
      runs: [run(RUN_1, 1, "completed", "2026-10-13T10:01:30.000Z")],
      nodes: [{ id: "node-1", runId: RUN_1 }],
      runtimeRequests: [{ id: "runtime-request:native:x%2Fy", nodeId: "node-1", kind: "command", status: "resolved",
        responseCapability: { type: "message" }, createdAt: "2026-10-13T10:01:10.000Z",
        resolvedAt: "2026-10-13T10:01:12.000Z", decision: "accept" }],
      turnItems: [item("command_execution", { id: "turn-item:cmd", runId: RUN_1, input: "ls", status: "failed" })],
    })).thread;
    const approval = snapshot.activities!.find((activity) => activity.kind === "approval.resolved")!;
    assert.match(String(approval.id), /^v2:[a-f0-9]{40}$/);
    assert.equal(approval.turnId, RUN_1);
    assert.deepEqual(approval.payload, { decision: "accept" });
    const tool = snapshot.activities!.find((activity) => activity.kind === "tool.completed")!;
    assert.equal(tool.id, "turn-item:cmd");
    assert.equal((tool.payload as Record<string, unknown>).status, "failed");
  });

  it("treats imported history without runs as idle and settles nothing implicitly", () => {
    const snapshot = threadFromV2(detail({ runs: [], messages: [
      { id: "m-1", threadId: "thread-1", runId: null, nodeId: null, role: "user", text: "Old", attachments: [],
        streaming: false, createdAt: "2026-09-12T02:00:00.000Z", updatedAt: "2026-09-12T02:00:00.000Z" },
    ] }, { settledOverride: "settled", settledAt: "2026-09-13T00:00:00.000Z" }));
    const transcript = normalizeTranscript(snapshot);
    assert.equal(transcript.session.status, "idle");
    assert.equal(transcript.session.settled, true);
    assert.deepEqual(transcript.turns.map((turn) => turn.id), ["message:m-1"]);
  });
});
