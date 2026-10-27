import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ArchiveStore, AssistantArchive, redactText } from "../src/assistant-archive.js";
import { loadConfig } from "../src/config.js";
import { assertArchivePlatform } from "../src/archive-platform.js";
import type { T3Client, T3ThreadSnapshot, T3Thread } from "../src/types.js";

function archiveTest(name: string, run: () => void | Promise<void>): void {
  test(name, { skip: !["darwin", "linux"].includes(process.platform) ? "Optional archive requires POSIX ownership and durable filesystem operations" : false }, run);
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const at = "2026-09-04T12:00:00.000Z";
const projectId = "assistant-project";
function message(index: number, overrides = {}) { return { id: `assistant:msg_${index}`, role: "assistant" as const, text: `Answer ${index}`, turnId: `turn-${index}`, streaming: false, createdAt: at, updatedAt: at, ...overrides }; }
function thread(messages = [message(0)], overrides = {}): T3Thread { return { id: "thread-1", projectId, title: "A task", modelSelection: { instanceId: "codex", model: "test" }, runtimeMode: "approval-required", interactionMode: "default", createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: at, latestTurn: { turnId: "turn-0", state: "completed", requestedAt: at, startedAt: at, completedAt: at }, session: { status: "ready", activeTurnId: null, updatedAt: at }, messages, ...overrides }; }
function page(item: T3Thread, hasMore = false, beforeCursor: string | null = null): T3ThreadSnapshot { return { snapshotSequence: 1, thread: item, page: { hasMore, beforeCursor, snapshotSequence: 1, threadSequence: 1 } }; }
async function fixture(pages?: T3ThreadSnapshot[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "assistant-archive-"))); roots.push(root);
  const config = loadConfig({ BRIDGE_TOKEN: "a".repeat(32), T3_ACCESS_TOKEN: "test-upstream-secret", BRIDGE_ARCHIVE_PROJECT_ID: projectId, BRIDGE_ARCHIVE_WORKSPACE_ROOT: root });
  const history = pages ?? [page(thread())];
  const calls: string[] = [];
  const client = {
    shell: async () => ({ snapshotSequence: 1, updatedAt: at, projects: [{ id: projectId, workspaceRoot: root }], threads: [thread(), thread([], { id: "unrelated", projectId: "other" })] }),
    threadPage: async (id: string, cursor?: string) => { calls.push(`${id}:${cursor ?? "first"}`); return history[cursor ? Number(cursor) : 0]!; },
  } as unknown as T3Client;
  const archive = new AssistantArchive(config, client);
  return { root, config, client, calls, archive, store: new ArchiveStore(config.archive!), history };
}

archiveTest("archive is disabled unless both settings exist; allowlist and root enforced", () => {
  const base = { BRIDGE_TOKEN: "a".repeat(32), T3_ACCESS_TOKEN: "test" };
  assert.equal(loadConfig({ ...base, BRIDGE_ARCHIVE_PROJECT_ID: projectId }).archive, null);
  assert.equal(loadConfig({ ...base, BRIDGE_ARCHIVE_WORKSPACE_ROOT: "/tmp/assistant" }).archive, null);
  assert.throws(() => loadConfig({ ...base, BRIDGE_ARCHIVE_WORKSPACE_ROOT: "../bad" }));
  assert.throws(() => loadConfig({ ...base, BRIDGE_ARCHIVE_PROJECT_ID: projectId, BRIDGE_ARCHIVE_WORKSPACE_ROOT: "/tmp/assistant", BRIDGE_PROJECT_IDS: "other" }));
});

archiveTest("exports all pages, merges stable colon IDs, and never fetches unrelated threads", async () => {
  const f = await fixture([page(thread(Array.from({ length: 100 }, (_, i) => message(i + 100))), true, "1"), page(thread(Array.from({ length: 101 }, (_, i) => message(i))), true, "2"), page(thread([message(200)]))]);
  await f.archive.poll();
  assert.equal(f.archive.status().state, "ok");
  const state = (await f.store.state("thread-1"))!;
  assert.equal(state.messages.length, 201);
  assert.deepEqual(f.calls, ["thread-1:first", "thread-1:1", "thread-1:2"]);
  const exported = state.exportedAt;
  await f.archive.poll();
  assert.equal((await f.store.state("thread-1"))!.exportedAt, exported);
  const restarted = new AssistantArchive(f.config, f.client); await restarted.poll();
  assert.equal((await f.store.state("thread-1"))!.messages.length, 201);
});

archiveTest("keeps recorded turn ids when T3 V2 imports history without them", async () => {
  const f = await fixture([page(thread([message(0)]))]);
  await f.archive.poll();
  f.history[0] = page(thread([message(0, { turnId: null })], { latestTurn: null, session: null, updatedAt: "2026-10-13T08:01:00.000Z" }));
  await f.archive.poll();
  const state = (await f.store.state("thread-1"))!;
  assert.equal(state.sourceUpdatedAt, "2026-10-13T08:01:00.000Z");
  assert.equal(state.messages[0]!.turnId, "turn-0");
});

archiveTest("only exports settled user-visible text and allowlisted approval decisions", async () => {
  const item = thread([message(0), message(1, { role: "system", text: "SECRET SYSTEM PROMPT" }) as never, message(2, { streaming: true }), message(3, { text: 'hello test-upstream-secret sk-proj-AbCdEf1234567890 ![[file]]' })], {
    activities: [{ id: "activity:approval", kind: "approval.resolved", createdAt: at, turnId: "turn-0", payload: { decision: "accept", secret: "RAW SECRET" } }, { id: "activity:tool", kind: "tool.completed", createdAt: at, turnId: "turn-0", payload: { status: "completed", stdout: "RAW TOOL TRACE" } }],
  });
  const f = await fixture([page(item)]); await f.archive.poll();
  const state = (await f.store.state("thread-1"))!;
  assert.equal(state.messages.length, 2); assert.equal(state.decisions.length, 1); assert.equal(state.outcomes.length, 1);
  const text = (await f.store.read(state.paths[0]!))!;
  assert.match(text, /REDACTED/); assert.doesNotMatch(text, /SECRET|RAW TOOL|test-upstream-secret|sk-proj-/);
  assert.match(text, /```text\nhello/);
});

archiveTest("active turns are excluded even when their assistant message is not streaming", async () => {
  const earlier = "2026-09-03T12:00:00.000Z";
  const item = thread([message(0, { createdAt: earlier }), message(2)], { session: { status: "running", activeTurnId: "turn-2", updatedAt: at }, latestTurn: { turnId: "turn-2", state: "running", completedAt: null, requestedAt: at } });
  const f = await fixture([page(item)]); await f.archive.poll();
  assert.deepEqual((await f.store.state("thread-1"))!.messages.map((m) => m.id), ["assistant:msg_0"]);
});

archiveTest("wrong project/thread, unstable pages, and cursor loops fail closed", async () => {
  for (const histories of [[page(thread([], { projectId: "other" }))], [page(thread([], { id: "other" }))], [page(thread(), true, "1"), page(thread([], { updatedAt: "2026-09-05T12:00:00.000Z" }))], [page(thread(), true, "1"), page(thread(), true, "1")]]) {
    const f = await fixture(histories); await f.archive.poll();
    assert.equal(f.archive.status().state, "error"); assert.equal(await f.store.state("thread-1"), null);
    assert.doesNotMatch(f.archive.status().message, /test-upstream-secret/);
  }
});

archiveTest("private files reject traversal and symlink destinations", async () => {
  const f = await fixture();
  await assert.rejects(() => f.store.write("../escape.md", "x"));
  await assert.rejects(() => f.store.write("/tmp/escape.md", "x"));
  await mkdir(join(f.root, "vault"));
  await symlink(tmpdir(), join(f.root, "vault", "inbox"));
  await f.archive.poll(); assert.equal(f.archive.status().state, "error");
});

archiveTest("partial output write retries from durable intent after restart", async () => {
  const f = await fixture();
  const original = ArchiveStore.prototype.write;
  let failed = false;
  ArchiveStore.prototype.write = async function(path, text) { if (!failed && path.endsWith("Conversation.md")) { failed = true; throw new Error("simulated disk failure"); } await original.call(this, path, text); };
  try { await f.archive.poll(); } finally { ArchiveStore.prototype.write = original; }
  assert.equal(f.archive.status().state, "error");
  assert.equal((await f.store.state("thread-1"))!.exportedAt, "");
  const retry = new AssistantArchive(f.config, f.client); await retry.poll();
  assert.equal(retry.status().state, "ok");
  const state = (await f.store.state("thread-1"))!;
  assert.ok(state.exportedAt); assert.match((await f.store.read(state.paths[0]!))!, /Answer 0/);
});

archiveTest("explicit task classification moves completed/cancelled records and links outcome", async () => {
  const f = await fixture(); await f.archive.poll();
  const active = (await f.store.state("thread-1"))!.paths[0]!;
  assert.match(active, /vault\/inbox\/tasks/);
  await assert.rejects(() => f.store.task("thread-1", { collection: "unclassified", status: "completed", outcome: "done", updatedAt: at }));
  for (const status of ["completed", "cancelled"] as const) {
    await f.store.task("thread-1", { collection: "work", status, outcome: "Result recorded", updatedAt: at });
    const state = (await f.store.state("thread-1"))!;
    assert.match(state.paths[0]!, /vault\/work\/archive\/2026\/09/);
    assert.match((await f.store.read(state.paths[1]!))!, /Result recorded/);
  }
  assert.equal(await f.store.read(active), null);
});

archiveTest("forget requires exact review, removes selected messages and notes, persists exclusions", async () => {
  const f = await fixture([page(thread([message(0), message(1)]))]); await f.archive.poll();
  await f.store.write("vault/personal/memories/saved.md", "Answer 0");
  const plan = await f.store.previewForget("thread-1", ["assistant:msg_0"], ["vault/personal/memories/saved.md"]);
  await assert.rejects(() => f.store.applyForget(plan.id, "wrong", async () => {}));
  let refreshed: string[] = [];
  await f.store.applyForget(plan.id, plan.id, async (paths) => { refreshed = paths; });
  assert.ok(refreshed.includes("personal/memories/saved.md"));
  assert.equal(await f.store.read("vault/personal/memories/saved.md"), null);
  await new AssistantArchive(f.config, f.client).poll();
  assert.deepEqual((await f.store.state("thread-1"))!.messages.map((message) => message.id), ["assistant:msg_1"]);
});

archiveTest("changed review is refused; whole-thread forget survives restart and sync failure", async () => {
  const f = await fixture(); await f.archive.poll();
  const plan = await f.store.previewForget("thread-1", [], []);
  const path = plan.files[0]!.path;
  await f.store.write(path, "edited");
  await assert.rejects(() => f.store.applyForget(plan.id, plan.id, async () => {}), /changed/);
  const fresh = await f.store.previewForget("thread-1", [], []);
  await assert.rejects(() => f.store.applyForget(fresh.id, fresh.id, async () => { throw new Error("sync failed"); }));
  assert.equal(await f.store.state("thread-1"), null);
  await f.archive.poll(); assert.equal(f.archive.status().state, "error");
  await f.store.finishForget(async () => {});
  const restarted = new AssistantArchive(f.config, f.client); await restarted.poll();
  assert.equal(restarted.status().state, "ok"); assert.equal(await f.store.state("thread-1"), null);
  assert.equal(await f.store.read(path), null);
});

test("known pasted credential formats are redacted", () => {
  assert.doesNotMatch(redactText("password=123456 https://user:pass@example.com/?token=abcdef Bearer tokenvalue"), /123456|user:pass|abcdef|tokenvalue/);
});

archiveTest("forget removes orphan atomic-write copies left by a crashed exporter", async () => {
  const f = await fixture(); await f.archive.poll();
  const state = (await f.store.state("thread-1"))!;
  const orphan = `${state.paths[0]}.11111111-1111-1111-1111-111111111111.tmp`;
  await f.store.write(orphan, "Old sensitive copy");
  const plan = await f.store.previewForget("thread-1", [], []);
  await f.store.applyForget(plan.id, plan.id, async () => {});
  assert.equal(await f.store.read(orphan), null);
});

archiveTest("note-only forgetting needs no archive thread and preserves review/retry checks", async () => {
  const f = await fixture();
  const path = "vault/personal/memories/standalone.md";
  await f.store.write(path, "Standalone memory");
  const stale = await f.store.previewForget(null, [], [path]);
  assert.equal(stale.threadId, null);
  await f.store.write(path, "Corrected memory");
  await assert.rejects(() => f.store.applyForget(stale.id, stale.id, async () => {}), /changed/);
  const plan = await f.store.previewForget(null, [], [path]);
  await assert.rejects(() => f.store.applyForget(plan.id, plan.id, async () => { throw new Error("sync unavailable"); }));
  assert.equal(await f.store.read(path), null);
  let refreshed: string[] = [];
  await f.store.finishForget(async (paths) => { refreshed = paths; });
  assert.deepEqual(refreshed, ["personal/memories/standalone.md"]);
  assert.deepEqual((await f.store.exclusions()).threads, []);
  await assert.rejects(() => f.store.previewForget(null, [], []));
});


test("unsupported archive platforms reject opt-in before files are accessed while defaults remain usable", () => {
  assert.throws(() => assertArchivePlatform("win32"), /supported only on macOS and Linux/);
  assert.doesNotThrow(() => assertArchivePlatform("darwin"));
  assert.doesNotThrow(() => assertArchivePlatform("linux"));
  const base = { BRIDGE_TOKEN: "a".repeat(32) };
  const config = loadConfig(base);
  assert.equal(config.archive, null);
  assert.equal(new AssistantArchive(config, {} as T3Client).status().state, "disabled");
  if (process.platform === "win32") {
    for (const settings of [{ BRIDGE_ARCHIVE_PROJECT_ID: projectId }, { BRIDGE_ARCHIVE_WORKSPACE_ROOT: join(tmpdir(), "archive") }, { BRIDGE_ARCHIVE_PROJECT_ID: projectId, BRIDGE_ARCHIVE_WORKSPACE_ROOT: join(tmpdir(), "archive") }]) {
      assert.throws(() => loadConfig({ ...base, ...settings }), /supported only on macOS and Linux/);
    }
    assert.throws(() => new ArchiveStore({ projectId, workspaceRoot: join(tmpdir(), "archive") }), /supported only on macOS and Linux/);
  }
});
