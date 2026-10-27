import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { ManagedEnvironmentRouter } from "../src/environment-router.js";
import { createBridgeServer } from "../src/server.js";
import { faceclawToken } from "../src/faceclaw.js";
import type {
  T3Client, T3Descriptor, T3ModelCatalog, T3NewSessionSelection, T3Project,
  T3ShellSnapshot, T3ThreadShell, T3ThreadSnapshot, Transcriber,
} from "../src/types.js";

const BRIDGE_TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF";
const updatedAt = "2026-09-12T00:00:00.000Z";

class EnvironmentClient implements T3Client {
  readonly project: T3Project;
  readonly threadShell: T3ThreadShell;
  sends = 0;
  threadCalls = 0;

  constructor(readonly environmentId: string, readonly label: string, readonly sequence: number) {
    this.project = { id: "shared-project", title: `${label} project`, defaultModelSelection: null,
      createdAt: updatedAt, updatedAt };
    this.threadShell = { id: "shared-thread", projectId: this.project.id, title: `${label} thread`,
      modelSelection: { instanceId: "provider", model: "model" }, runtimeMode: "approval-required",
      interactionMode: "default", createdAt: updatedAt, updatedAt, archivedAt: null,
      settledOverride: null, settledAt: null, latestUserMessageAt: updatedAt, latestTurn: null, session: null };
  }
  async descriptor(): Promise<T3Descriptor> {
    return { environmentId: this.environmentId, label: this.label, serverVersion: "1",
      capabilities: { threadSettlement: true } };
  }
  async shell(): Promise<T3ShellSnapshot> {
    return { snapshotSequence: this.sequence, projects: [this.project], threads: [this.threadShell], updatedAt };
  }
  async thread(): Promise<T3ThreadSnapshot> {
    this.threadCalls++;
    return { snapshotSequence: this.sequence, thread: { ...this.threadShell, messages: [{ id: `message-${this.environmentId}`,
      role: "assistant", text: this.label, turnId: null, streaming: false, createdAt: updatedAt, updatedAt }] } };
  }
  async modelCatalog(): Promise<T3ModelCatalog> { return { providers: [] }; }
  async startSession(_input: { project: T3Project; threadId: string; text: string; runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access"; selection?: T3NewSessionSelection }) {
    return { sequence: this.sequence };
  }
  async sendMessage() { this.sends++; return { sequence: this.sequence }; }
  async steerMessage() { return { sequence: this.sequence }; }
  async replyMessage() { this.sends++; return { sequence: this.sequence }; }
  async settleThread() { return { sequence: this.sequence }; }
  async respondToPlanInput() { return { sequence: this.sequence }; }
}

function rpc(socket: WebSocket, id: string, method: string, params: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC timed out")), 2_000);
    const listener = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.type !== "response" || value.id !== id) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
}

describe("multi-environment bridge protocol", () => {
  it("aggregates duplicate ids and routes scoped operations to the selected environment", async () => {
    const local = new EnvironmentClient("local", "This computer", 1);
    const remote = new EnvironmentClient("remote", "Studio Mac", 2);
    const router = new ManagedEnvironmentRouter();
    router.register({ descriptor: await local.descriptor(), kind: "local", client: local, primary: true });
    router.register({ descriptor: await remote.descriptor(), kind: "t3-connect", client: remote });
    const config = { ...loadConfig({ BRIDGE_TOKEN, T3_ACCESS_TOKEN: "unused" }), port: 0, pollIntervalMs: 60_000 };
    const transcriber = { transcribe: async () => "" } as Transcriber;
    const server = createBridgeServer(config, router, transcriber);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/faceclaw/events`,
      ["even-t3-v1", `auth.${faceclawToken(BRIDGE_TOKEN)}`]);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    try {
      const listed = await rpc(socket, "list", "sessions.list", {});
      assert.equal(listed.ok, true);
      const sessions = listed.result as { unsettled: Array<{ id: string; environmentId: string }>; environments: unknown[] };
      assert.deepEqual(sessions.unsettled.map(item => [item.id, item.environmentId]), [
        ["shared-thread", "local"], ["shared-thread", "remote"],
      ]);
      assert.equal(sessions.environments.length, 2);

      const selected = await rpc(socket, "remote-transcript", "transcript.get",
        { environmentId: "remote", threadId: "shared-thread" });
      assert.equal(selected.ok, true);
      assert.equal((selected.result as { session: { environmentId: string }; turns: Array<{ messages: Array<{ text: string }> }> }).session.environmentId, "remote");
      assert.equal((selected.result as { turns: Array<{ messages: Array<{ text: string }> }> }).turns[0]?.messages[0]?.text, "Studio Mac");
      assert.equal(local.threadCalls, 0);
      assert.ok(remote.threadCalls >= 1);

      const legacy = await rpc(socket, "primary-transcript", "transcript.get", { threadId: "shared-thread" });
      assert.equal(legacy.ok, true);
      assert.equal((legacy.result as { session: { environmentId: string } }).session.environmentId, "local");

      const sent = await rpc(socket, "remote-send", "turn.send",
        { environmentId: "remote", threadId: "shared-thread", text: "hello" });
      assert.equal(sent.ok, true);
      assert.equal((sent.result as { environmentId: string }).environmentId, "remote");
      assert.equal(remote.sends, 1);
      assert.equal(local.sends, 0);

      const reply = await rpc(socket, "remote-reply", "turn.reply",
        { environmentId: "remote", threadId: "shared-thread", text: "reviewed hello" });
      assert.equal(reply.ok, true);
      assert.equal((reply.result as { environmentId: string }).environmentId, "remote");
      assert.equal(remote.sends, 2);
      assert.equal(local.sends, 0);
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
