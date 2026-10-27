import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createBridgeServer } from "../src/server.js";
import { faceclawToken } from "../src/faceclaw.js";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { normalizeTranscript } from "../src/normalize.js";
import { normalizePendingProposedPlan, SessionControlsService } from "../src/session-controls.js";
import type { T3Client, T3Thread, T3ShellSnapshot } from "../src/types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const at = "2026-09-04T10:00:00.000Z";
const proposed = { id: "plan-1", turnId: "turn-1", planMarkdown: "# Plan\n\nMake the change.", implementedAt: null,
  implementationThreadId: null, createdAt: at, updatedAt: at };
function fixture() {
  const thread: Mutable<T3Thread> = { id: "thread", projectId: "project", title: "Fixture", interactionMode: "plan", runtimeMode: "approval-required",
    modelSelection: { instanceId: "codex", model: "model", options: [{ id: "reasoningEffort", value: "high" }, { id: "private", value: "not exposed" }] },
    createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null,
    latestTurn: { turnId: "turn-1", state: "completed", requestedAt: at, startedAt: at, completedAt: at },
    session: { status: "ready", activeTurnId: null, updatedAt: at }, messages: [], hasPendingUserInput: false, proposedPlans: [proposed] };
  const shell: Mutable<T3ShellSnapshot> = { snapshotSequence: 1, updatedAt: at, projects: [{ id: "project", title: "Fixture",
    defaultModelSelection: null, createdAt: at, updatedAt: at }], threads: [thread] };
  const approvals: Parameters<NonNullable<T3Client["approvePlan"]>>[0][] = [];
  const reasoning: Parameters<NonNullable<T3Client["setReasoning"]>>[0][] = [];
  const client = { shell: async () => shell, thread: async () => ({ snapshotSequence: 1, thread }),
    approvePlan: async (input: typeof approvals[number]) => { approvals.push(input); return { sequence: 2 }; },
    setReasoning: async (input: typeof reasoning[number]) => { reasoning.push(input); return { sequence: 2 }; } };
  const config = loadConfig({ BRIDGE_TOKEN: "x".repeat(32), T3_ACCESS_TOKEN: "fixture" });
  return { thread, shell, approvals, reasoning, client, config,
    params: { threadId: "thread", planId: "plan-1", revision: normalizePendingProposedPlan(thread)!.revision },
    reasoningParams: { threadId: "thread", reasoningId: "low", expectedModel: { instanceId: "codex", model: "model" } } };
}

describe("completed plan and reasoning boundaries", () => {
  it("exposes only structured latest completed plans and allowlisted session settings", () => {
    const f = fixture();
    const normalized = normalizeTranscript({ snapshotSequence: 1, thread: f.thread });
    assert.equal(normalized.pendingProposedPlan?.planMarkdown, proposed.planMarkdown);
    assert.deepEqual(normalized.session.modelSelection, { instanceId: "codex", model: "model", reasoningId: "high" });
    assert.equal(JSON.stringify(normalized).includes("not exposed"), false);
    for (const mutation of [
      { interactionMode: "default" as const }, { archivedAt: at }, { hasPendingUserInput: true },
      { session: { status: "running", activeTurnId: "turn-1", updatedAt: at } },
      { proposedPlans: [{ ...proposed, implementedAt: at }] },
      { proposedPlans: [{ ...proposed, implementationThreadId: "other" }] },
      { proposedPlans: [{ ...proposed, turnId: "older" }] },
      { proposedPlans: [{ ...proposed, planMarkdown: "x".repeat(64_001) }] },
      { proposedPlans: [{ ...proposed, updatedAt: "invalid" }] },
      { proposedPlans: [proposed, proposed] },
      { proposedPlans: [{ ...proposed, implementedAt: undefined }] },
    ]) assert.equal(normalizePendingProposedPlan({ ...f.thread, ...mutation }), null);
  });
  it("approves one exact revision with durable deduplication and preserved permission mode", async () => {
    const f = fixture(); const service = new SessionControlsService(f.client, f.config);
    await Promise.all([service.approve(f.params), service.approve(f.params)]);
    assert.equal(f.approvals.length, 1);
    assert.equal(f.approvals[0]!.thread.runtimeMode, "approval-required");
    assert.equal(f.approvals[0]!.planMarkdown, proposed.planMarkdown);
    await new SessionControlsService(f.client, f.config).approve(f.params);
    assert.equal(f.approvals[0]!.commandId, f.approvals[1]!.commandId);
  });
  it("rejects stale, swapped, hidden, deleted and busy sessions before approving or setting reasoning", async () => {
    for (const mutation of [
      (f: ReturnType<typeof fixture>) => { f.config = { ...f.config, projectIds: new Set(["other"]) }; },
      (f: ReturnType<typeof fixture>) => { f.shell.projects = []; },
      (f: ReturnType<typeof fixture>) => { f.client.thread = async () => ({ snapshotSequence: 2, thread: { ...f.thread, id: "other" } }); },
      (f: ReturnType<typeof fixture>) => { f.client.thread = async () => ({ snapshotSequence: 2, thread: { ...f.thread, projectId: "other" } }); },
      (f: ReturnType<typeof fixture>) => { f.thread.archivedAt = at; },
      (f: ReturnType<typeof fixture>) => { f.thread.session = { status: "starting", updatedAt: at }; },
      (f: ReturnType<typeof fixture>) => { f.thread.hasPendingUserInput = true; },
      (f: ReturnType<typeof fixture>) => { f.thread.session = { status: "ready", activeTurnId: "queued", updatedAt: at }; },
    ]) {
      const f = fixture(); mutation(f); const service = new SessionControlsService(f.client, f.config);
      await assert.rejects(service.approve(f.params));
      await assert.rejects(service.setReasoning(f.reasoningParams));
      assert.equal(f.approvals.length + f.reasoning.length, 0);
    }
    const f = fixture(); f.thread.proposedPlans = [{ ...proposed, planMarkdown: "A revised plan" }];
    await assert.rejects(new SessionControlsService(f.client, f.config).approve(f.params), { code: "plan_unavailable" });
    assert.equal(f.approvals.length, 0);
  });
  it("keeps ambiguous approval attempts locked and never exposes upstream error details", async () => {
    const f = fixture(); let calls = 0;
    f.client.approvePlan = async () => { calls++; throw new Error("private token"); };
    const service = new SessionControlsService(f.client, f.config);
    for (let i = 0; i < 2; i++) await assert.rejects(service.approve(f.params), { code: "plan_approval_uncertain" });
    assert.equal(calls, 1);
  });
  it("rejects extra permission/source fields and changed model or malformed reasoning", async () => {
    const f = fixture(); const service = new SessionControlsService(f.client, f.config);
    await assert.rejects(service.approve({ ...f.params, runtimeMode: "full-access" }), { code: "invalid_request" });
    await assert.rejects(service.approve({ ...f.params, sourceThreadId: "other" }), { code: "invalid_request" });
    for (const params of [{ ...f.reasoningParams, reasoningId: "../private" }, { ...f.reasoningParams, runtimeMode: "full-access" },
      { ...f.reasoningParams, expectedModel: { instanceId: "codex", model: "changed" } }]) await assert.rejects(service.setReasoning(params));
    assert.equal(f.approvals.length + f.reasoning.length, 0);
    assert.deepEqual(await service.setReasoning(f.reasoningParams), { threadId: "thread", reasoningId: "low", sequence: 2 });
  });
});


it("routes controls over the separately authenticated native Faceclaw socket and preserves project scope", async () => {
  const f = fixture();
  const client = { ...f.client, sendMessage: async () => ({ sequence: 3 }) } as unknown as T3Client;
  const server = createBridgeServer(f.config, client, { transcribe: async () => "unused" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/faceclaw/events`,
    ["even-t3-v1", `auth.${faceclawToken(f.config.bridgeToken)}`]);
  try {
    await once(socket, "open");
    let sequence = 0;
    const rpc = (method: string, params: unknown) => new Promise<{ ok: boolean; error?: { code: string } }>((resolve) => {
      const id = `controls-${++sequence}`;
      const receive = (data: WebSocket.RawData) => { const value = JSON.parse(data.toString()); if (value.id === id) { socket.off("message", receive); resolve(value); } };
      socket.on("message", receive); socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
    });
    assert.equal((await rpc("thread.reasoning.set", f.reasoningParams)).ok, true);
    assert.equal((await rpc("plan.approve", f.params)).ok, true);
    assert.equal((await rpc("turn.send", { threadId: "thread", text: "Draft", interactionMode: "plan" })).ok, true);
    assert.equal((await rpc("turn.steer", { threadId: "thread", text: "Draft", interactionMode: "plan" })).error?.code, "invalid_request");
    f.shell.projects = [];
    assert.equal((await rpc("thread.reasoning.set", f.reasoningParams)).ok, false);
    assert.equal((await rpc("plan.approve", f.params)).ok, false);
    assert.equal(f.approvals.length, 1); assert.equal(f.reasoning.length, 1);
  } finally { socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
