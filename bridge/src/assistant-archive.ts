import { createHash, randomUUID } from "node:crypto";
import { assertArchivePlatform } from "./archive-platform.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BridgeConfig, T3Client, T3ThreadSnapshot } from "./types.js";

export type ArchiveConfig = NonNullable<BridgeConfig["archive"]>;
export type Collection = "personal" | "work" | "unclassified";
export type TaskStatus = "active" | "completed" | "cancelled";
export interface ArchiveStatus {
  state: "disabled" | "pending" | "ok" | "error";
  lastSuccessAt: string | null;
  message: string;
}
interface SavedMessage { id: string; role: "user" | "assistant"; text: string; createdAt: string; turnId: string | null; files: string[] }
interface SavedDecision { id: string; createdAt: string; turnId: string | null; decision: string }
interface SavedOutcome { id: string; createdAt: string; turnId: string | null; kind: string; status: string }
interface TaskControl { collection: Collection; status: TaskStatus; outcome: string; updatedAt: string }
interface RecordState {
  version: 1; projectId: string; threadId: string; title: string;
  messages: SavedMessage[]; decisions: SavedDecision[]; outcomes: SavedOutcome[]; sourceUpdatedAt: string;
  control: TaskControl; paths: string[]; exportedAt: string;
}
interface Exclusions { version: 1; projectId: string; threads: string[]; messages: Record<string, string[]> }
interface ForgetPlan {
  version: 1; id: string; projectId: string; threadId: string | null;
  messageIds: string[]; wholeThread: boolean; files: { path: string; digest: string }[];
  stateDigest: string | null; createdAt: string;
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DECISIONS = new Set(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const missing = (error: unknown) => record(error) && error.code === "ENOENT";
function id(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new Error("Invalid source identifier"); }
function sourceId(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) throw new Error("Invalid message or activity identifier"); }
function date(value: unknown): asserts value is string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid source timestamp"); }

/** Defense in depth for accidentally pasted credentials. Raw provider payloads never enter this function. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let result = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, "[REDACTED TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization|bridge[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^\s&#]+/gi, "$1[REDACTED]");
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  return result.replace(/\u0000/g, "");
}
function literal(text: string): string {
  // Notes are evidence, never executable HTML, images, or embedded Obsidian content.
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** Local-owner boundary: all components must be real directories, never symlinks. */
export class ArchiveStore {
  constructor(readonly config: ArchiveConfig) { assertArchivePlatform(); }
  async safePath(path: string, createParents = false): Promise<string> {
    if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) throw new Error("Unsafe archive path");
    const root = this.config.workspaceRoot;
    if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root) throw new Error("Unsafe workspace root");
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) || (rootStat.mode & 0o022) !== 0) throw new Error("Workspace must not be writable by other users");
    const target = join(root, path);
    let current = root;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const leaf = index === parts.length - 1;
      let stat;
      try { stat = await lstat(current); } catch (error) {
        if (!missing(error)) throw error;
        if (!leaf && createParents) { await mkdir(current, { mode: 0o700 }); stat = await lstat(current); }
        else if (leaf) return target;
        else throw error;
      }
      if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory()) || (stat.mode & 0o022) !== 0) throw new Error("Unsafe archive file boundary");
    }
    return target;
  }
  async read(path: string): Promise<string | null> {
    try {
      const handle = await open(await this.safePath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private async cleanTemporaryCopies(path: string): Promise<void> {
    const target = await this.safePath(path);
    const name = target.slice(target.lastIndexOf("/") + 1);
    for (const candidate of await readdir(dirname(target))) {
      if (candidate.startsWith(`${name}.`) && /^[0-9a-f-]{36}\.tmp$/.test(candidate.slice(name.length + 1))) {
        const relative = `${path.slice(0, path.lastIndexOf("/"))}/${candidate}`;
        await rm(await this.safePath(relative), { force: true });
      }
    }
  }
  async write(path: string, text: string): Promise<void> {
    const target = await this.safePath(path, true);
    await this.cleanTemporaryCopies(path);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await this.safePath(path);
      await rename(temporary, target);
      const directory = await open(dirname(target), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(path: string): Promise<void> {
    try { await this.cleanTemporaryCopies(path); await rm(await this.safePath(path), { force: true }); }
    catch (error) { if (!missing(error)) throw error; }
  }
  statePath(threadId: string): string { id(threadId); return `.runtime/archive/records/${hash(threadId)}.json`; }
  async state(threadId: string): Promise<RecordState | null> {
    const text = await this.read(this.statePath(threadId));
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.version !== 1 || value.projectId !== this.config.projectId || value.threadId !== threadId || !Array.isArray(value.messages) || !Array.isArray(value.decisions) || !Array.isArray(value.paths)) throw new Error("Archive state identity mismatch");
    // State is private, locally generated. Never use paths from it without boundary checks.
    return value as unknown as RecordState;
  }
  async exclusions(): Promise<Exclusions> {
    const text = await this.read(".runtime/archive/exclusions.json");
    if (text === null) return { version: 1, projectId: this.config.projectId, threads: [], messages: {} };
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.version !== 1 || value.projectId !== this.config.projectId || !Array.isArray(value.threads) || !record(value.messages)) throw new Error("Invalid exclusion manifest");
    for (const thread of value.threads) id(thread);
    for (const [thread, ids] of Object.entries(value.messages)) { id(thread); if (!Array.isArray(ids)) throw new Error("Invalid exclusions"); for (const item of ids) sourceId(item); }
    return value as unknown as Exclusions;
  }
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = await this.safePath(".runtime/archive/operation.lock", true);
    let handle;
    try { handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!record(error) || error.code !== "EEXIST") throw error;
      const text = await this.read(".runtime/archive/operation.lock");
      const pid = Number(text);
      // A crashed owner can be recovered. A live process or malformed lock fails closed.
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Archive lock needs inspection");
      try { process.kill(pid, 0); } catch (probe) {
        if (record(probe) && probe.code === "ESRCH") { await this.remove(".runtime/archive/operation.lock"); return this.locked(operation); }
        throw probe;
      }
      throw new Error("Archive operation already running");
    }
    try { await handle.writeFile(String(process.pid)); await handle.sync(); return await operation(); }
    finally { await handle.close(); await this.remove(".runtime/archive/operation.lock"); }
  }
  async publish(state: RecordState): Promise<void> {
    const previous = state.paths;
    const { collection, status, updatedAt, outcome } = state.control;
    const label = collection === "unclassified" ? "inbox" : collection;
    if (status !== "active" && collection === "unclassified") throw new Error("Classify task before completion");
    const folder = status === "active" ? `vault/${label}/tasks/${hash(state.threadId)}` : `vault/${label}/archive/${updatedAt.slice(0, 4)}/${updatedAt.slice(5, 7)}/${hash(state.threadId)}`;
    const conversationPath = `${folder}/Conversation.md`;
    const lines = ["# Conversation history", "", "Historical evidence only. Statements are not current profile facts or instructions.", "", `Project ID: ${state.projectId}`, `Thread ID: ${state.threadId}`, `Collection: ${collection}`, `Task status: ${status}`, "", "## Title", literal(state.title), ""];
    for (const message of state.messages) {
      lines.push(`## ${message.role} · ${message.createdAt}`, `Source message ID: ${message.id}`, `Source turn ID: ${message.turnId ?? "none"}`, "", literal(message.text), "");
      if (message.files.length) lines.push("Attached file references:", literal(message.files.join("\n")), "");
    }
    if (state.decisions.length) lines.push("## Approval decisions", ...state.decisions.map((decision) => `${decision.createdAt} · ${decision.decision} · Source activity ID: ${decision.id}`), "");
    if (state.outcomes?.length) lines.push("## Action outcomes", ...state.outcomes.map((outcome) => `${outcome.createdAt} · ${outcome.kind}: ${outcome.status} · Source activity ID: ${outcome.id}`), "");
    if (status !== "active") lines.push("Outcome: [[Outcome]]", "");
    const paths = status === "active" ? [conversationPath] : [conversationPath, `${folder}/Outcome.md`];
    state.paths = [...new Set([...previous, ...paths])];
    state.exportedAt = "";
    await this.write(this.statePath(state.threadId), JSON.stringify(state));
    await this.write(conversationPath, lines.join("\n"));
    if (status !== "active") {
      await this.write(paths[1]!, `# Task outcome\n\nStatus: ${status}\nRecorded: ${updatedAt}\n\n${literal(outcome)}\n\nHistory: [[Conversation]]\n`);
    }
    for (const old of previous) if (!paths.includes(old)) { this.assertOwnedPath(old); await this.remove(old); }
    state.paths = paths;
    state.exportedAt = new Date().toISOString();
    await this.write(this.statePath(state.threadId), JSON.stringify(state));
  }
  assertOwnedPath(path: string): void {
    if (!/^vault\/(?:(?:personal|work|inbox)\/tasks|(?:personal|work)\/archive\/\d{4}\/\d{2})\/[a-f0-9]{64}\/(?:Conversation|Outcome)\.md$/.test(path)) throw new Error("Not an owned archive path");
  }
  async task(threadId: string, control: TaskControl): Promise<void> {
    id(threadId);
    if (!["personal", "work", "unclassified"].includes(control.collection) || !["active", "completed", "cancelled"].includes(control.status)) throw new Error("Invalid task control");
    if (control.status !== "active" && (!control.outcome.trim() || control.collection === "unclassified")) throw new Error("Completed/cancelled tasks need collection and outcome");
    date(control.updatedAt);
    await this.locked(async () => {
      const state = await this.state(threadId);
      if (!state) throw new Error("Thread must be exported before task bookkeeping");
      state.control = { ...control, outcome: redactText(control.outcome) };
      await this.publish(state);
    });
  }
  async previewForget(threadId: string | null, messageIds: string[], extraFiles: string[]): Promise<ForgetPlan> {
    if (threadId !== null) id(threadId); messageIds.forEach(sourceId);
    if (threadId === null && (messageIds.length || !extraFiles.length)) throw new Error("Note-only preview needs files and no message IDs");
    return this.locked(async () => {
      const state = threadId === null ? null : await this.state(threadId);
      if (threadId !== null && !state) throw new Error("No archive exists for this thread");
      for (const messageId of messageIds) if (!state?.messages.some((message) => message.id === messageId)) throw new Error("Unknown message ID");
      const files = [...(state?.paths ?? []), ...extraFiles.map((path) => {
        if (!/^vault\/(?:personal|work)\/(?:memories|notes)\/.+\.md$/.test(path)) throw new Error("Additional removal must be an explicit personal/work memory or note");
        return path;
      })];
      const reviewed: ForgetPlan["files"] = [];
      for (const path of [...new Set(files)]) { const text = await this.read(path); if (text === null) throw new Error("Review file is missing"); reviewed.push({ path, digest: hash(text) }); }
      const plan: ForgetPlan = { version: 1, id: randomUUID(), projectId: this.config.projectId, threadId, messageIds, wholeThread: threadId !== null && messageIds.length === 0, files: reviewed, stateDigest: state ? hash(JSON.stringify(state)) : null, createdAt: new Date().toISOString() };
      await this.write(`.runtime/archive/forget-plans/${plan.id}.json`, JSON.stringify(plan));
      return plan;
    });
  }
  async applyForget(planId: string, confirmation: string, syncIndex: (paths: string[]) => Promise<void>): Promise<void> {
    id(planId); if (confirmation !== planId) throw new Error("Confirm the exact reviewed plan ID");
    await this.locked(async () => {
      const raw = await this.read(`.runtime/archive/forget-plans/${planId}.json`);
      if (!raw) throw new Error("Forget preview is missing");
      const plan = JSON.parse(raw) as ForgetPlan;
      if (plan.version !== 1 || plan.projectId !== this.config.projectId || plan.id !== planId) throw new Error("Forget plan identity mismatch");
      const state = plan.threadId === null ? null : await this.state(plan.threadId);
      if ((state ? hash(JSON.stringify(state)) : null) !== plan.stateDigest) throw new Error("Archive changed; preview again");
      for (const file of plan.files) if (hash(await this.read(file.path) ?? "") !== file.digest) throw new Error("Reviewed file changed; preview again");
      // Persist intent before removals. Recovery replays only this exact reviewed plan.
      await this.write(".runtime/archive/forget-pending.json", JSON.stringify(plan));
      await this.executeForget(plan, syncIndex);
    });
  }
  private async executeForget(plan: ForgetPlan, syncIndex: (paths: string[]) => Promise<void>): Promise<void> {
    if (plan.version !== 1 || plan.projectId !== this.config.projectId) throw new Error("Forget recovery identity mismatch");
    if (plan.threadId !== null) id(plan.threadId); id(plan.id); plan.messageIds.forEach(sourceId);
    const exclusions = await this.exclusions();
    if (plan.threadId !== null && plan.wholeThread) exclusions.threads = [...new Set([...exclusions.threads, plan.threadId])];
    else if (plan.threadId !== null) exclusions.messages[plan.threadId] = [...new Set([...(exclusions.messages[plan.threadId] ?? []), ...plan.messageIds])];
    await this.write(".runtime/archive/exclusions.json", JSON.stringify(exclusions));
    const state = plan.threadId === null ? null : await this.state(plan.threadId);
    if (plan.threadId !== null && plan.wholeThread) {
      if (state) for (const path of state.paths) { this.assertOwnedPath(path); await this.remove(path); }
      await this.remove(this.statePath(plan.threadId));
    } else if (plan.threadId !== null) {
      if (!state) throw new Error("Forget recovery state missing");
      const turns = new Set(state.messages.filter((message) => plan.messageIds.includes(message.id)).map((message) => message.turnId));
      state.messages = state.messages.filter((message) => !plan.messageIds.includes(message.id));
      state.decisions = state.decisions.filter((decision) => !turns.has(decision.turnId));
      state.outcomes = (state.outcomes ?? []).filter((outcome) => !turns.has(outcome.turnId));
      state.title = "Conversation with removed material";
      state.control.outcome = state.control.status === "active" ? "" : "Outcome removed with source material.";
      await this.publish(state);
    }
    for (const file of plan.files) {
      if (plan.wholeThread || !state?.paths.includes(file.path)) {
        if (!/^vault\/(?:personal|work)\/(?:memories|notes)\/.+\.md$/.test(file.path)) this.assertOwnedPath(file.path);
        await this.remove(file.path);
      }
    }
    await syncIndex(plan.files.map((file) => file.path.slice("vault/".length)));
    await this.remove(".runtime/archive/forget-pending.json");
    await this.remove(`.runtime/archive/forget-plans/${plan.id}.json`);
  }
  async finishForget(syncIndex: (paths: string[]) => Promise<void>): Promise<void> {
    await this.locked(async () => {
      const pending = await this.read(".runtime/archive/forget-pending.json");
      if (pending === null) throw new Error("No pending forget operation");
      await this.executeForget(JSON.parse(pending) as ForgetPlan, syncIndex);
    });
  }
}

export class AssistantArchive {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private current: ArchiveStatus;
  private readonly store: ArchiveStore | null;
  constructor(private readonly config: BridgeConfig, private readonly client: T3Client, private readonly changed: (status: ArchiveStatus) => void = () => undefined) {
    this.store = config.archive ? new ArchiveStore(config.archive) : null;
    this.current = { state: this.store ? "pending" : "disabled", lastSuccessAt: null, message: this.store ? "Waiting for archive check" : "Assistant archive is disabled" };
  }
  status(): ArchiveStatus { return { ...this.current }; }
  start(): void { if (!this.store || this.timer) return; void this.poll(); this.timer = setInterval(() => void this.poll(), 60_000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async poll(): Promise<void> {
    if (!this.store || this.busy) return;
    this.busy = true;
    try {
      const store = this.store;
      await store.locked(async () => {
        if (await store.read(".runtime/archive/forget-pending.json") !== null) throw new Error("Pending forget operation");
        const shell = await this.client.shell();
        const projects = shell.projects.filter((project) => project.id === store.config.projectId && !project.deletedAt);
        if (projects.length !== 1 || projects[0]?.workspaceRoot !== store.config.workspaceRoot) throw new Error("Archive project identity mismatch");
        const exclusions = await store.exclusions();
        if (!this.client.threadPage) throw new Error("Paginated thread reader unavailable");
        const seen = new Set<string>();
        for (const thread of shell.threads) {
          if (thread.projectId !== store.config.projectId) continue;
          id(thread.id); if (seen.has(thread.id)) throw new Error("Duplicate thread identity"); seen.add(thread.id);
          if (exclusions.threads.includes(thread.id)) continue;
          await this.exportThread(store, thread.id, exclusions);
        }
      });
      this.current = { state: "ok", lastSuccessAt: new Date().toISOString(), message: "Assistant history archived" };
    } catch {
      this.current = { ...this.current, state: "error", message: "Assistant archive incomplete. Check local archive configuration or pending forget operation; retry runs every 60 seconds." };
    } finally { this.busy = false; this.changed(this.status()); }
  }
  private async exportThread(store: ArchiveStore, threadId: string, exclusions: Exclusions): Promise<void> {
    const previous = await store.state(threadId);
    const messages = new Map(previous?.messages.map((message) => [message.id, message]) ?? []);
    const decisions = new Map(previous?.decisions.map((decision) => [decision.id, decision]) ?? []);
    const outcomes = new Map(previous?.outcomes?.map((outcome) => [outcome.id, outcome]) ?? []);
    const pages = new Set<string>();
    let cursor: string | undefined;
    let newest: T3ThreadSnapshot | undefined;
    const forgotten = new Set(exclusions.messages[threadId] ?? []);
    const forbiddenTurns = new Set<string | null>();
    const secrets = [this.config.bridgeToken, this.config.t3AccessToken ?? "", this.config.bridgePassphrase ?? "", ...(this.config.additionalRedactionSecrets?.() ?? [])];
    do {
      const snapshot = await this.client.threadPage!(threadId, cursor);
      const thread = snapshot.thread;
      if (thread.id !== threadId || thread.projectId !== store.config.projectId || !snapshot.page || !Number.isSafeInteger(snapshot.page.snapshotSequence) || snapshot.page.snapshotSequence !== snapshot.snapshotSequence) throw new Error("Archive page identity mismatch");
      if (newest && (thread.updatedAt !== newest.thread.updatedAt || (snapshot.page.threadSequence !== undefined && snapshot.page.threadSequence !== newest.page?.threadSequence))) throw new Error("Thread changed during pagination");
      newest ??= snapshot;
      date(thread.updatedAt);
      const active = newest.thread.session?.activeTurnId ?? (newest.thread.latestTurn?.completedAt === null ? newest.thread.latestTurn?.turnId : null);
      for (const raw of thread.messages) {
        if (!record(raw)) throw new Error("Invalid message");
        sourceId(raw.id);
        if (raw.role !== "user" && raw.role !== "assistant") continue;
        if (typeof raw.text !== "string" || typeof raw.streaming !== "boolean") throw new Error("Invalid message content");
        date(raw.createdAt); date(raw.updatedAt);
        if (raw.turnId !== null) sourceId(raw.turnId);
        if (forgotten.has(raw.id)) { messages.delete(raw.id); forbiddenTurns.add(raw.turnId); continue; }
        if (raw.streaming || (active && raw.turnId === active) || (active && raw.createdAt >= (newest.thread.latestTurn?.requestedAt ?? ""))) { messages.delete(raw.id); continue; }
        const files: string[] = [];
        if (Array.isArray(raw.attachments)) for (const attachment of raw.attachments) {
          if (record(attachment) && (attachment.type === "file" || attachment.type === "image") && typeof attachment.id === "string" && typeof attachment.name === "string") {
            id(attachment.id); files.push(redactText(`${attachment.name} [attachment ${attachment.id}]`, secrets));
          }
        }
        // T3 V2 imports V1 history without turn ids; keep the id this archive recorded before.
        const turnId = raw.turnId ?? messages.get(raw.id)?.turnId ?? null;
        messages.set(raw.id, { id: raw.id, role: raw.role, text: redactText(raw.text, secrets), createdAt: raw.createdAt, turnId, files });
      }
      for (const activity of thread.activities ?? []) {
        if (!record(activity) || !["approval.resolved", "tool.completed", "tool.denied"].includes(String(activity.kind))) continue;
        sourceId(activity.id); date(activity.createdAt);
        if (activity.turnId !== null) sourceId(activity.turnId);
        if (active && activity.turnId === active) continue;
        if (activity.kind === "tool.completed" || activity.kind === "tool.denied") {
          const status = activity.kind === "tool.denied" ? "denied" : record(activity.payload) && typeof activity.payload.status === "string" && ["completed", "failed", "success", "error", "cancelled", "interrupted"].includes(activity.payload.status) ? activity.payload.status : "finished; success not verified";
          outcomes.set(activity.id, { id: activity.id, createdAt: activity.createdAt, turnId: activity.turnId, kind: "tool", status });
          continue;
        }
        if (!record(activity.payload) || typeof activity.payload.decision !== "string" || !DECISIONS.has(activity.payload.decision)) continue;
        decisions.set(activity.id, { id: activity.id, createdAt: activity.createdAt, turnId: activity.turnId, decision: activity.payload.decision });
      }
      if (!snapshot.page.hasMore) { if (snapshot.page.beforeCursor !== null) throw new Error("Inconsistent final page"); break; }
      const next = snapshot.page.beforeCursor;
      if (!next || next.length > 4096 || pages.has(next)) throw new Error("Archive pagination did not advance");
      pages.add(next); cursor = next;
      if (pages.size > 10_000) throw new Error("Archive page safety limit; incomplete");
    } while (true);
    for (const messageId of forgotten) messages.delete(messageId);
    for (const [key, decision] of decisions) if (forbiddenTurns.has(decision.turnId)) decisions.delete(key);
    for (const [key, outcome] of outcomes) if (forbiddenTurns.has(outcome.turnId)) outcomes.delete(key);
    const state: RecordState = {
      version: 1, projectId: store.config.projectId, threadId,
      title: forgotten.size ? "Conversation with removed material" : redactText(newest!.thread.title, secrets),
      messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      decisions: [...decisions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      outcomes: [...outcomes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      sourceUpdatedAt: newest!.thread.updatedAt,
      control: previous?.control ?? { collection: "unclassified", status: "active", outcome: "", updatedAt: new Date().toISOString() },
      paths: previous?.paths ?? [], exportedAt: new Date().toISOString(),
    };
    // Only rewrite changed source/control records. Completed-turn history remains stable across retries.
    if (previous?.exportedAt && previous.sourceUpdatedAt === state.sourceUpdatedAt && JSON.stringify(previous.messages) === JSON.stringify(state.messages) && JSON.stringify(previous.decisions) === JSON.stringify(state.decisions) && JSON.stringify(previous.outcomes ?? []) === JSON.stringify(state.outcomes)) return;
    await store.publish(state);
  }
}
