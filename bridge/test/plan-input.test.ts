import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { attachPendingQuestions, normalizePendingPlanInput, PlanInputService, validatePlanAnswers } from "../src/plan-input.js";
import { normalizeTranscript } from "../src/normalize.js";
import type { T3Client, T3Thread, T3ShellSnapshot } from "../src/types.js";

const at = "2026-09-04T10:00:00.000Z";
const q = { id: "Which option should we use?", header: "Scope", question: "Which option should we use?",
  options: [{ label: "Small", description: "One change" }, { label: "Large", description: "Two changes" }], multiSelect: false };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
function active(): Mutable<T3Thread> {
  return { id: "thread", projectId: "project", title: "Fixture", interactionMode: "plan", runtimeMode: "approval-required",
    modelSelection: { instanceId: "codex", model: "model" }, createdAt: at, updatedAt: at, archivedAt: null,
    settledOverride: null, settledAt: null, latestTurn: { turnId: "turn", state: "running", requestedAt: at, startedAt: at, completedAt: null },
    session: { status: "running", activeTurnId: "turn", updatedAt: at }, messages: [], hasPendingUserInput: true,
    activities: [{ kind: "user-input.requested", turnId: "turn", createdAt: at, payload: { requestId: "request", questions: [q], private: "not forwarded" } }] };
}
function fixture() {
  const thread = active();
  const shell: Mutable<T3ShellSnapshot> = { snapshotSequence: 1, updatedAt: at, projects: [{ id: "project", title: "Fixture", workspaceRoot: "/fixture",
    defaultModelSelection: null, createdAt: at, updatedAt: at }], threads: [thread] };
  const calls: Parameters<T3Client["respondToPlanInput"]>[0][] = [];
  const client = { shell: async () => shell, thread: async () => ({ snapshotSequence: 1, thread }),
    respondToPlanInput: async (input: Parameters<T3Client["respondToPlanInput"]>[0]) => { calls.push(input); return { sequence: 2 }; } };
  const config = loadConfig({ BRIDGE_TOKEN: "x".repeat(32), T3_ACCESS_TOKEN: "fixture" });
  const params = { threadId: thread.id, requestId: "request", revision: normalizePendingPlanInput(thread)!.revision,
    answers: [{ questionId: q.id, optionIndexes: [0], text: "" }] };
  return { thread, shell, calls, client, config, params };
}

describe("pending plan input normalization", () => {
  it("normalizes actual T3 activity schema without exposing unrelated payloads", () => {
    const pending = normalizePendingPlanInput(active())!;
    assert.deepEqual(pending.questions, [q]);
    assert.match(pending.revision, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(pending).includes("not forwarded"), false);
    assert.deepEqual(normalizeTranscript({ snapshotSequence: 1, thread: active() }).pendingPlanInput, pending);
  });
  it("never presents approvals, stopped/old turns or explicitly absent pending input", () => {
    for (const mutate of [
      (t: T3Thread) => ({ ...t, hasPendingUserInput: false }),
      (t: T3Thread) => ({ ...t, session: null }),
      (t: T3Thread) => ({ ...t, latestTurn: { ...t.latestTurn!, state: "completed" } }),
      (t: T3Thread) => ({ ...t, activities: [{ ...t.activities![0], kind: "approval.requested" }] }),
      (t: T3Thread) => ({ ...t, activities: [{ ...t.activities![0], turnId: "other-turn" }] }),
    ]) assert.equal(normalizePendingPlanInput(mutate(active())), null);
  });
  it("removes resolved and failed requests, selecting the newest remaining request", () => {
    const t = active();
    const requested = t.activities![0]!;
    t.activities = [requested, { ...requested, createdAt: "2026-09-04T10:01:00.000Z", payload: { requestId: "next", questions: [q] } },
      { kind: "user-input.resolved", createdAt: "2026-09-04T10:02:00.000Z", payload: { requestId: "next" } }];
    assert.equal(normalizePendingPlanInput(t)?.requestId, "request");
    t.activities = [...t.activities, { kind: "provider.user-input.respond.failed", createdAt: "2026-09-04T10:03:00.000Z", payload: { requestId: "request", detail: "private provider error" } }];
    assert.equal(normalizePendingPlanInput(t), null);
  });
  it("fails closed on malformed, duplicate, oversized question schemas and revises reordered options", () => {
    const original = normalizePendingPlanInput(active())!;
    for (const questions of [[q, q], [{ ...q, options: [{ label: "", description: "empty" }] }],
      Array.from({ length: 13 }, (_, i) => ({ ...q, id: String(i) })), [{ ...q, question: "x".repeat(4001) }]]) {
      const t = active();
      t.activities = [{ ...t.activities![0], payload: { requestId: "request", questions } }];
      assert.equal(normalizePendingPlanInput(t), null);
    }
    const changed = active();
    changed.activities = [{ ...changed.activities![0], payload: { requestId: "request", questions: [{ ...q, options: [...q.options].reverse() }] } }];
    assert.notEqual(normalizePendingPlanInput(changed)!.revision, original.revision);
  });
});

describe("pending question previews", () => {
  it("attaches the first bounded question to blocked sessions only", async () => {
    const thread = active();
    thread.activities = [{ ...thread.activities![0], payload: { requestId: "request",
      questions: [{ ...q, question: `Which  option\nshould ${"we ".repeat(200)}use?` }, { ...q, id: "second" }] } }];
    const sessions: Array<{ id: string; projectId: string; hasPendingUserInput?: boolean; pendingQuestion?: string }> = [
      { id: "thread", projectId: "project", hasPendingUserInput: true }, { id: "idle", projectId: "project" }];
    const read: string[] = [];
    await attachPendingQuestions(sessions, () => ({ thread: async (id: string) => { read.push(id); return { snapshotSequence: 1, thread }; } }));
    assert.deepEqual(read, ["thread"]);
    assert.equal(sessions[0]!.pendingQuestion!.length, 280);
    assert.match(sessions[0]!.pendingQuestion!, /^Which option should we we .*\.\.\. \(\+1 more\)$/);
    assert.equal(sessions[1]!.pendingQuestion, undefined);
  });
  it("leaves the preview empty when the thread read fails or belongs elsewhere", async () => {
    const sessions = [{ id: "thread", projectId: "other", hasPendingUserInput: true } as { id: string; projectId: string; hasPendingUserInput: boolean; pendingQuestion?: string }];
    await attachPendingQuestions(sessions, () => ({ thread: async () => ({ snapshotSequence: 1, thread: active() }) }));
    assert.equal(sessions[0]!.pendingQuestion, undefined);
    sessions[0]!.projectId = "project";
    await attachPendingQuestions(sessions, () => ({ thread: async () => { throw new Error("offline"); } }));
    assert.equal(sessions[0]!.pendingQuestion, undefined);
  });
});

describe("plan submission boundary", () => {
  it("submits one full canonical answer batch, never starting a turn or changing permissions", async () => {
    const f = fixture();
    assert.deepEqual(await new PlanInputService(f.client, f.config).submit(f.params), { threadId: "thread", requestId: "request", sequence: 2 });
    assert.deepEqual(f.calls[0]!.answers, { [q.id]: "Small" });
    assert.match(f.calls[0]!.commandId, /^even-plan-[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["answers", "commandId", "requestId", "threadId"]);
  });
  it("rejects missing, duplicate, mixed, invented and out-of-range answers before dispatch", async () => {
    for (const answers of [[], [fixture().params.answers[0], fixture().params.answers[0]],
      [{ questionId: "invented", optionIndexes: [0], text: "" }], [{ questionId: q.id, optionIndexes: [8], text: "" }],
      [{ questionId: q.id, optionIndexes: [0, 1], text: "" }], [{ questionId: q.id, optionIndexes: [0], text: "also custom" }],
      [{ questionId: q.id, optionIndexes: [], text: "x".repeat(8001) }]]) {
      const f = fixture();
      await assert.rejects(new PlanInputService(f.client, f.config).submit({ ...f.params, answers }), { code: "invalid_plan_answers" });
      assert.equal(f.calls.length, 0);
    }
  });
  it("supports prose IDs, safe special property names, multi-select and dictated text", () => {
    const request = normalizePendingPlanInput(active())!;
    request.questions = [{ ...q, id: "__proto__", multiSelect: true }, { ...q, id: "custom" }];
    const answers = validatePlanAnswers([{ questionId: "__proto__", optionIndexes: [0, 1], text: "" },
      { questionId: "custom", optionIndexes: [], text: "A specific answer" }], request, 8000);
    assert.equal(Object.getPrototypeOf(answers), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(answers, "__proto__")?.value, ["Small", "Large"]);
    assert.equal(answers.custom, "A specific answer");
  });
  it("freshly enforces project visibility, thread identity and request revision", async () => {
    for (const mutation of [
      (f: ReturnType<typeof fixture>) => { f.config = { ...f.config, projectIds: new Set(["other"]) }; },
      (f: ReturnType<typeof fixture>) => { f.shell.projects = []; },
      (f: ReturnType<typeof fixture>) => { f.client.thread = async () => ({ snapshotSequence: 1, thread: { ...f.thread, projectId: "other" } }); },
      (f: ReturnType<typeof fixture>) => { f.params.revision = "0".repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.params.requestId = "approval-request"; },
      (f: ReturnType<typeof fixture>) => { f.thread.activities = []; },
    ]) {
      const f = fixture(); mutation(f);
      await assert.rejects(new PlanInputService(f.client, f.config).submit(f.params));
      assert.equal(f.calls.length, 0);
    }
  });
  it("coalesces concurrent submissions and rejects altered answers after sending", async () => {
    const f = fixture();
    const service = new PlanInputService(f.client, f.config);
    await Promise.all([service.submit(f.params), service.submit(f.params), service.submit(f.params)]);
    assert.equal(f.calls.length, 1);
    await assert.rejects(service.submit({ ...f.params, answers: [{ questionId: q.id, optionIndexes: [1], text: "" }] }), { code: "plan_submission_conflict" });
    assert.equal(f.calls.length, 1);
  });
  it("keeps uncertain submissions locked and uses the same durable command ID after restart", async () => {
    const f = fixture();
    const commandIds: string[] = [];
    f.client.respondToPlanInput = async input => { commandIds.push(input.commandId); throw new Error("private upstream text"); };
    const service = new PlanInputService(f.client, f.config);
    for (let i = 0; i < 2; i++) await assert.rejects(service.submit(f.params), { code: "plan_submission_uncertain" });
    assert.equal(commandIds.length, 1);
    await assert.rejects(new PlanInputService(f.client, f.config).submit(f.params), { code: "plan_submission_uncertain" });
    assert.equal(commandIds[0], commandIds[1]);
  });
});


describe("normal-mode user-input requests", () => {
  it("forwards and answers an active normal-mode question through the same single-use response path", async () => {
    const f=fixture();f.thread.interactionMode="default";
    const request=normalizePendingPlanInput(f.thread)!;
    assert.deepEqual(request.questions,[q]);
    assert.deepEqual(normalizeTranscript({snapshotSequence:1,thread:f.thread}).pendingPlanInput,request);
    const service=new PlanInputService(f.client,f.config);
    await service.submit({...f.params,revision:request.revision});
    await service.submit({...f.params,revision:request.revision});
    assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0]!.answers,{[q.id]:"Small"});
    assert.equal(f.thread.interactionMode,"default");
  });
  it("allows freeform-only questions and rejects a normal-mode request resolved on the desktop",async()=>{
    const f=fixture();f.thread.interactionMode="default";
    f.thread.activities=[{...f.thread.activities![0],payload:{requestId:"request",questions:[{...q,options:[]}]}}];
    const request=normalizePendingPlanInput(f.thread)!;assert.equal(request.questions[0]!.options.length,0);
    const params={...f.params,revision:request.revision,answers:[{questionId:q.id,optionIndexes:[],text:"Use the glasses dashboard"}]};
    f.thread.activities=[...f.thread.activities,{kind:"user-input.resolved",createdAt:"2026-09-04T10:01:00.000Z",payload:{requestId:"request"}}];
    await assert.rejects(new PlanInputService(f.client,f.config).submit(params),{code:"plan_request_unavailable"});assert.equal(f.calls.length,0);
  });
});
