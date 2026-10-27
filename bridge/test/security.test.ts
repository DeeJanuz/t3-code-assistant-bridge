import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { completedTurn, normalizeProjects, normalizeSessions, normalizeTranscript } from "../src/normalize.js";
import { createBridgeServer } from "../src/server.js";
import { faceclawToken } from "../src/faceclaw.js";
import { assertPosixFeature } from "../src/platform-support.js";
import type {
  BridgeConfig,
  T3Client,
  T3Descriptor,
  T3ModelCatalog,
  T3NewSessionSelection,
  T3Project,
  T3ShellSnapshot,
  T3ThreadShell,
  T3ThreadSnapshot,
  Transcriber,
} from "../src/types.js";
import { pcmToWav, WhisperCppTranscriber } from "../src/voice.js";
import { normalizePendingPlanInput } from "../src/plan-input.js";

const BRIDGE_TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF";
const NATIVE_TOKEN = faceclawToken(BRIDGE_TOKEN);
const BROWSER_ORIGIN = "https://even-app.example";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    bridgeToken: BRIDGE_TOKEN,
    bridgePassphrase: "passphrase",
    projectIds: null,
    runtimeMode: "approval-required",
    pollIntervalMs: 60_000,
    rateLimitPerMinute: 1000,
    maxBodyBytes: 16_384,
    maxTextChars: 8000,
    maxUpstreamBytes: 8 * 1024 * 1024,
    upstreamTimeoutMs: 10_000,
    t3BaseUrl: new URL("http://127.0.0.1:3773"),
    t3AccessToken: "t3-secret",
    whisperServerUrl: new URL("http://127.0.0.1:8178/inference"),
    whisperLanguage: "en",
    whisperPartialIntervalMs: 1000,
    transcriptionTimeoutMs: 60_000,
    maxVoiceBytes: 9_600_000,
    ...overrides,
  };
}

const project: T3Project = {
  id: "project-1",
  title: "Even Realities",
  workspaceRoot: "/private/repository/path",
  defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

function thread(
  id: string,
  updatedAt: string,
  settledOverride: "settled" | "active" | null = null,
): T3ThreadShell {
  return {
    id,
    projectId: project.id,
    title: id,
    modelSelection: project.defaultModelSelection!,
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    archivedAt: null,
    settledOverride,
    settledAt: settledOverride === "settled" ? updatedAt : null,
    latestUserMessageAt: updatedAt,
    latestTurn: null,
    session: null,
  };
}

const shell: T3ShellSnapshot = {
  snapshotSequence: 7,
  projects: [project],
  threads: [
    thread("older", "2026-09-02T00:00:00.000Z"),
    thread("settled", "2026-09-04T00:00:00.000Z", "settled"),
    thread("newer", "2026-09-03T00:00:00.000Z"),
  ],
  updatedAt: "2026-09-04T00:00:00.000Z",
};

describe("completion metadata boundary", () => {
  it("exposes only explicitly completed turns, independent of settlement", () => {
    const base = thread("completion", "2026-09-04T12:00:00.000Z", "settled");
    assert.equal(completedTurn(base), null);
    const latestTurn = { turnId: "turn-1", state: "completed", requestedAt: base.updatedAt, startedAt: base.updatedAt, completedAt: base.updatedAt };
    const complete = { ...base, latestTurn };
    const expected = { id: "turn-1", completedAt: base.updatedAt };
    assert.deepEqual(completedTurn(complete), expected);
    assert.deepEqual(normalizeSessions({ ...shell, threads: [complete] }, config()).settled[0]?.completedTurn, expected);
    assert.deepEqual(normalizeTranscript(snapshot(complete)).session.completedTurn, expected);
    for (const state of ["running", "failed", "interrupted", "ready"]) {
      assert.equal(completedTurn({ ...complete, latestTurn: { ...latestTurn, state } }), null);
    }
    for (const turnId of ["", "x".repeat(201), "../private", "turn\nspoof"]) {
      assert.equal(completedTurn({ ...complete, latestTurn: { ...latestTurn, turnId } }), null);
    }
    for (const completedAt of [null, "invalid", "2026", "x".repeat(100)]) {
      assert.equal(completedTurn({ ...complete, latestTurn: { ...latestTurn, completedAt } }), null);
    }
  });
});

function snapshot(threadShell = shell.threads[0]!): T3ThreadSnapshot {
  return {
    snapshotSequence: 7,
    thread: {
      ...threadShell,
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "Do the work",
          turnId: null,
          streaming: false,
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "Done",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-09-02T00:00:10.000Z",
          updatedAt: "2026-09-02T00:02:05.000Z",
        },
      ],
    },
  };
}

class FakeT3Client implements T3Client {
  settlements: string[] = [];
  async settleThread(threadId: string): Promise<{ sequence: number }> {
    this.settlements.push(threadId);
    return { sequence: 10 };
  }
  planSubmissions: Parameters<T3Client["respondToPlanInput"]>[0][] = [];
  async respondToPlanInput(input: Parameters<T3Client["respondToPlanInput"]>[0]): Promise<{ sequence: number }> {
    this.planSubmissions.push(input);
    return { sequence: 8 };
  }
  shellCalls = 0;
  catalogCalls = 0;
  threadSequence = 7;
  starts: Array<{
    project: T3Project;
    threadId: string;
    text: string;
    runtimeMode: string;
    selection?: T3NewSessionSelection;
  }> = [];
  sends: Array<{ thread: T3ThreadShell; text: string }> = [];
  steers: Array<{ thread: T3ThreadShell; text: string }> = [];

  constructor(public shellSnapshot: T3ShellSnapshot = shell) {}

  async descriptor(): Promise<T3Descriptor> {
    return {
      environmentId: "environment-1",
      label: "Test",
      serverVersion: "0.0.38",
      capabilities: { threadSettlement: true },
    };
  }

  async shell(): Promise<T3ShellSnapshot> {
    this.shellCalls += 1;
    return this.shellSnapshot;
  }

  async thread(threadId: string): Promise<T3ThreadSnapshot> {
    return {
      ...snapshot(this.shellSnapshot.threads.find((value) => value.id === threadId) ?? this.shellSnapshot.threads[0]),
      snapshotSequence: this.threadSequence,
    };
  }

  async modelCatalog(): Promise<T3ModelCatalog> {
    this.catalogCalls += 1;
    return {
      providers: [
        {
          instanceId: "codex",
          label: "Codex Personal",
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isDefault: true,
              reasoning: {
                id: "reasoning",
                t3OptionId: "reasoningEffort",
                defaultChoiceId: "medium",
                choices: [
                  { id: "low", label: "Low", isDefault: false },
                  { id: "medium", label: "Medium", isDefault: true },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  async startSession(input: {
    project: T3Project;
    threadId: string;
    text: string;
    runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    selection?: T3NewSessionSelection;
  }): Promise<{ sequence: number }> {
    this.starts.push(input);
    return { sequence: 8 };
  }

  async sendMessage(input: {
    thread: T3ThreadShell;
    text: string;
  }): Promise<{ sequence: number }> {
    this.sends.push(input);
    return { sequence: 8 };
  }

  async steerMessage(input: {
    thread: T3ThreadShell;
    text: string;
  }): Promise<{ sequence: number }> {
    this.steers.push(input);
    return { sequence: 9 };
  }
  replies: Array<{ thread: T3ThreadShell; text: string }> = [];
  async replyMessage(input: { thread: T3ThreadShell; text: string }): Promise<{ sequence: number }> {
    this.replies.push(input);
    return { sequence: 10 };
  }
}

class FakeTranscriber implements Transcriber {
  calls = 0;
  async transcribe(pcm: readonly Buffer[], signal: AbortSignal): Promise<string> {
    assert.equal(signal.aborted, false);
    assert.equal(pcm.reduce((sum, chunk) => sum + chunk.byteLength, 0), 3200);
    this.calls += 1;
    return "dictated request";
  }
}

const servers: ReturnType<typeof createBridgeServer>[] = [];
const localServers: HttpServer[] = [];

afterEach(async () => {
  const httpServers = localServers.splice(0);
  for (const server of httpServers) server.closeAllConnections();
  await Promise.all(
    [...servers.splice(0), ...httpServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startLocalWhisper(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<URL> {
  const server = createHttpServer(handler);
  localServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/inference`);
}

async function startServer(
  client = new FakeT3Client(),
  transcriber = new FakeTranscriber(),
  configOverrides: Partial<BridgeConfig> = {},
) {
  const server = createBridgeServer(config(configOverrides), client, transcriber);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { client, transcriber, base: `http://127.0.0.1:${address.port}` };
}

function rpc(socket: WebSocket, id: string, method: string, params: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("RPC timed out")), 2000);
    const listener = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.type === "response" && value.id === id) {
        clearTimeout(timeout);
        socket.off("message", listener);
        resolve(value);
      }
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
}

async function openSocket(base: string): Promise<WebSocket> {
  const url = base.replace(/^http/, "ws") + "/v1/faceclaw/events";
  const socket = new WebSocket(url, ["even-t3-v1", `auth.${NATIVE_TOKEN}`]);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

describe("configuration security", () => {
  const baseEnv = {
    BRIDGE_TOKEN,
    T3_ACCESS_TOKEN: "t3-secret",
  };

  it("keeps the listener on loopback", () => {
    assert.equal(loadConfig(baseEnv).host, "127.0.0.1");
    assert.throws(() => loadConfig({ ...baseEnv, BRIDGE_HOST: "0.0.0.0" }), /BRIDGE_HOST must be a loopback address/);
  });

  it("refuses POSIX-only optional features on Windows instead of running them unprotected", () => {
    for (const platform of ["win32", "aix", "freebsd"] as const) {
      assert.throws(() => assertPosixFeature("Peer federation", "BRIDGE_PEER_DIRECTORY", platform), /only on macOS and Linux; leave BRIDGE_PEER_DIRECTORY unset/);
    }
    for (const platform of ["darwin", "linux"] as const) assertPosixFeature("Peer federation", "BRIDGE_PEER_DIRECTORY", platform);
  });

  it("rejects weak secrets", () => {
    assert.throws(() => loadConfig({ ...baseEnv, BRIDGE_TOKEN: "short" }), /BRIDGE_TOKEN/);
  });

  it("enables pairing only when a bounded passphrase is explicitly configured", () => {
    assert.equal(loadConfig(baseEnv).bridgePassphrase, null);
    assert.equal(
      loadConfig({ ...baseEnv, BRIDGE_PASSPHRASE: "passphrase" }).bridgePassphrase,
      "passphrase",
    );
    assert.throws(
      () => loadConfig({ ...baseEnv, BRIDGE_PASSPHRASE: "line\nbreak" }),
      /BRIDGE_PASSPHRASE/,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv, BRIDGE_PASSPHRASE: "x".repeat(257) }),
      /BRIDGE_PASSPHRASE/,
    );
  });

  it("rejects a non-loopback Whisper endpoint to prevent audio exfiltration", () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, WHISPER_SERVER_URL: "https://attacker.example/inference" }),
      /WHISPER_SERVER_URL must use http/,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv, WHISPER_SERVER_URL: "http://attacker.example/inference" }),
      /numeric loopback address/,
    );
  });
});

describe("normalization", () => {
  it("exposes T3 background work as subagents or monitoring and ignores unknown values", () => {
    const base = thread("older", "2026-09-01T12:00:00.000Z");
    const statuses = ["working", "monitoring", "future", null, undefined].map((backgroundLiveness) =>
      normalizeSessions({ ...shell, threads: [{ ...base, backgroundLiveness }] }, config()).unsettled[0]?.background);
    assert.deepEqual(statuses, ["subagents", "monitoring", null, null, null]);
  });
  it("uses conversation recency rather than settlement or thread metadata edits", () => {
    const older = { ...thread("older", "2026-09-01T12:00:00.000Z"),
      updatedAt: "2026-09-04T12:00:00.000Z", settledAt: "2026-09-04T12:00:00.000Z" };
    const newer = thread("newer", "2026-09-03T12:00:00.000Z");
    const result = normalizeSessions({ ...shell, threads: [older, newer] }, config());
    assert.deepEqual(result.unsettled.map(value => value.id), ["newer", "older"]);
    assert.equal(result.unsettled[1]?.lastActivityAt, "2026-09-01T12:00:00.000Z");
  });
  it("freezes a grouped snapshot sorted by last activity and omits workspace paths", () => {
    const result = normalizeSessions(shell, config());
    assert.deepEqual(
      result.unsettled.map((value) => value.id),
      ["newer", "older"],
    );
    assert.deepEqual(result.settled.map((value) => value.id), ["settled"]);
    assert.equal(JSON.stringify(result).includes("/private/repository/path"), false);
  });

  it("anchors a user message and following assistants in one timed turn", () => {
    const result = normalizeTranscript(snapshot(), project.title);
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0]?.id, "turn-1");
    assert.equal(result.turns[0]?.durationSeconds, 125);
    assert.equal(result.turns[0]?.separatorLabel, "WORKED 2M 5S");
    assert.deepEqual(
      result.turns[0]?.messages.map((message) => message.role),
      ["user", "assistant"],
    );
  });

  it("exposes bounded allowlisted live tool activity for the active turn", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities: [
          {
            kind: "task.progress",
            turnId,
            createdAt: "2026-09-04T15:00:02.000Z",
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:03.123Z",
          },
          {
            kind: "tool.completed",
            turnId,
            createdAt: "2026-09-04T15:00:03.456Z",
          },
        ],
      },
    });

    assert.deepEqual(result.liveActivity, {
      phase: "thinking",
      label: "Thinking",
      updatedAt: "2026-09-04T15:00:03.456Z",
    });
    assert.deepEqual(result.liveActivities, [
      {
        id: "tool:2026-09-04T15:00:03.123Z:0",
        kind: "tool",
        label: "tool call",
        startedAt: "2026-09-04T15:00:03.123Z",
        completedAt: "2026-09-04T15:00:03.456Z",
      },
    ]);
  });

  it("does not expose untrusted activity prose, payload fields, or unknown kinds", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const secret = "DO_NOT_EXPOSE_SECRET";
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities: [
          {
            kind: `attacker.${secret}`,
            turnId,
            createdAt: "2026-09-04T15:00:04.000Z",
            summary: secret,
            payload: { command: `printenv ${secret}` },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:03.000Z",
            summary: secret,
            payload: {
              itemType: "mcp_tool_call",
              title: secret,
              detail: secret,
              data: {
                kind: "read",
                toolName: secret,
                input: { command: `printenv ${secret}`, path: `/private/${secret}` },
                result: secret,
              },
            },
          },
        ],
      },
    });

    assert.deepEqual(result.liveActivity, {
      phase: "tool",
      label: "Using a tool",
      updatedAt: "2026-09-04T15:00:03.000Z",
    });
    assert.deepEqual(result.liveActivities, [
      {
        id: "tool:2026-09-04T15:00:03.000Z:0",
        kind: "tool",
        label: "used MCP tool",
        startedAt: "2026-09-04T15:00:03.000Z",
        completedAt: null,
      },
    ]);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  it("matches T3's compact tool detail from exact structured display fields", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const activities = [
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:02.000Z",
        payload: {
          itemType: "command_execution",
          data: { item: { command: "sed -n '1,120p' \"/Users/example/project/SKILL.md\"" } },
        },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:03.000Z",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "/Users/example/project/normalize.ts" },
                { path: "/Users/example/project/types.ts" },
                { path: "/Users/example/project/security.test.ts" },
              ],
            },
          },
        },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:04.000Z",
        payload: { itemType: "mcp_tool_call", data: { item: { tool: "preview_snapshot" } } },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:05.000Z",
        payload: { itemType: "collab_agent_tool_call", data: { item: { tool: "wait" } } },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:06.000Z",
        payload: { itemType: "web_search", data: { item: { query: "private search text" } } },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:07.000Z",
        payload: { itemType: "image_view", data: { item: { path: "/tmp/glasses-frame.png" } } },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:08.000Z",
        payload: {
          itemType: "dynamic_tool_call",
          data: { kind: "read", rawInput: { target_file: "/project/src/app.ts" } },
        },
      },
      {
        kind: "tool.started",
        turnId,
        createdAt: "2026-09-04T15:00:09.000Z",
        payload: { itemType: "future_tool", data: { item: { tool: "attacker_text" } } },
      },
    ];
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities,
      },
    });

    assert.deepEqual(
      result.liveActivities.map((activity) => activity.label),
      [
        "ran sed -n '1,120p' \"/Users/example/project/SKILL.md\"",
        "changed /Users/example/project/normalize.ts +2",
        "called preview_snapshot",
        "agent wait",
        "searched web",
        "viewed /tmp/glasses-frame.png",
        "read /project/src/app.ts",
        "tool call",
      ],
    );
    assert.equal(JSON.stringify(result).includes("private search text"), false);
    assert.equal(JSON.stringify(result).includes("attacker_text"), false);
    assert.equal(result.liveActivities.every((activity) => activity.label.length <= 120), true);
  });

  it("redacts secrets and control characters from bounded structured tool previews", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const secrets = [
      "environment-value",
      "header-token-value",
      "url-password",
      "query-token-value",
      "cli-password-value",
      "DO_NOT_EXPOSE_SECRET",
      "result-command-secret",
      "tool_secret_name",
      "API_TOKEN_hunter2.env",
      "first-quoted-secret",
      "double-quoted-secret",
      "second-assignment-value",
    ];
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities: [
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:02.000Z",
            summary: "DO_NOT_EXPOSE_SECRET",
            payload: {
              itemType: "command_execution",
              title: "DO_NOT_EXPOSE_SECRET",
              detail: "DO_NOT_EXPOSE_SECRET",
              data: {
                item: {
                  command:
                    "SAFE_ENV=environment-value curl -H 'Authorization: Bearer header-token-value' " +
                    "https://user:url-password@example.test/path?access_token=query-token-value " +
                    "--password cli-password-value DO_NOT_EXPOSE_SECRET\n\t\u202e" +
                    "x".repeat(300),
                  result: { command: "result-command-secret", output: "DO_NOT_EXPOSE_SECRET" },
                },
              },
            },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:03.000Z",
            payload: { itemType: "mcp_tool_call", data: { item: { tool: "tool_secret_name" } } },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:04.000Z",
            payload: {
              itemType: "file_change",
              data: { item: { changes: [{ path: "/private/API_TOKEN_hunter2.env" }] } },
            },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:05.000Z",
            payload: {
              itemType: "command_execution",
              data: { item: { result: { command: "result-command-secret" } } },
            },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:06.000Z",
            payload: {
              itemType: "command_execution",
              data: {
                item: {
                  command:
                    "/bin/zsh -lc 'API_KEY=first-quoted-secret " +
                    "SAFE_MODE=second-assignment-value npm test'",
                },
              },
            },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:07.000Z",
            payload: {
              itemType: "command_execution",
              data: {
                item: {
                  command:
                    '/bin/zsh -lc "ACCESS_TOKEN=double-quoted-secret OTHER_ENV=second-assignment-value npm test"',
                },
              },
            },
          },
        ],
      },
    });

    const serialized = JSON.stringify(result.liveActivities);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false, secret);
    assert.equal(serialized.includes("[redacted]"), true);
    assert.equal(serialized.includes("\n"), false);
    assert.equal(serialized.includes("\t"), false);
    assert.equal(serialized.includes("\u202e"), false);
    assert.equal(result.liveActivities.every((activity) => activity.label.length <= 120), true);
    assert.equal(result.liveActivities[3]?.label, "ran command");
    assert.match(result.liveActivities[4]?.label ?? "", /^ran \/bin\/zsh -lc '\[redacted\] SAFE_MODE=\[redacted\] npm test'$/u);
    assert.match(result.liveActivities[5]?.label ?? "", /^ran \/bin\/zsh -lc "\[redacted\] OTHER_ENV=\[redacted\] npm test"$/u);
  });

  it("ignores orphan tool completions and caps live tools without renumbering retained IDs", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const activities = [
      { kind: "tool.completed", turnId, createdAt: "2026-09-04T15:00:00.000Z" },
      ...Array.from({ length: 34 }, (_, index) => ({
        kind: "tool.started",
        turnId,
        createdAt: new Date(Date.parse("2026-09-04T15:00:01.000Z") + index * 1000).toISOString(),
      })),
    ];
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities,
      },
    });

    assert.equal(result.liveActivities.length, 32);
    assert.equal(result.liveActivities[0]?.id, "tool:2026-09-04T15:00:03.000Z:0");
    assert.equal(result.liveActivities[31]?.id, "tool:2026-09-04T15:00:34.000Z:0");
  });

  it("enriches a generic started tool from its bounded completed payload", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities: [
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:02.000Z",
            payload: { itemType: "command_execution", toolCallId: "call-1" },
          },
          {
            kind: "tool.completed",
            turnId,
            createdAt: "2026-09-04T15:00:03.000Z",
            payload: {
              itemType: "command_execution",
              toolCallId: "call-1",
              data: { item: { command: "npm run typecheck" } },
            },
          },
        ],
      },
    });

    assert.equal(result.liveActivities[0]?.label, "ran npm run typecheck");
    assert.equal(result.liveActivities[0]?.completedAt, "2026-09-04T15:00:03.000Z");
  });

  it("pairs overlapping tool activity only through a validated internal correlation", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const secretCorrelation = "private-call-id";
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities: [
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:02.000Z",
            payload: { toolCallId: "first-call" },
          },
          {
            kind: "tool.started",
            turnId,
            createdAt: "2026-09-04T15:00:03.000Z",
            payload: { toolCallId: secretCorrelation },
          },
          {
            kind: "tool.completed",
            turnId,
            createdAt: "2026-09-04T15:00:04.000Z",
            payload: { toolCallId: secretCorrelation },
          },
          {
            kind: "tool.completed",
            turnId,
            createdAt: "2026-09-04T15:00:05.000Z",
            payload: { toolCallId: "first-call" },
          },
        ],
      },
    });

    assert.equal(result.liveActivities[0]?.completedAt, "2026-09-04T15:00:05.000Z");
    assert.equal(result.liveActivities[1]?.completedAt, "2026-09-04T15:00:04.000Z");
    assert.equal(JSON.stringify(result).includes(secretCorrelation), false);
  });

  it("leaves overlapping uncorrelated tool activity open instead of guessing", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const result = normalizeTranscript({
      ...snapshot(running),
      thread: {
        ...snapshot(running).thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:01.000Z",
          completedAt: null,
        },
        session: {
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-09-04T15:00:01.000Z",
        },
        activities: [
          { kind: "tool.started", turnId, createdAt: "2026-09-04T15:00:02.000Z" },
          { kind: "tool.started", turnId, createdAt: "2026-09-04T15:00:03.000Z" },
          { kind: "tool.completed", turnId, createdAt: "2026-09-04T15:00:04.000Z" },
        ],
      },
    });

    assert.deepEqual(
      result.liveActivities.map((activity) => activity.completedAt),
      [null, null],
    );
  });

  it("removes live activity when either the session or latest turn stops running", () => {
    const running = thread("running", "2026-09-04T15:00:00.000Z");
    const turnId = "turn-live";
    const activeThread = {
      ...snapshot(running).thread,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-09-04T15:00:00.000Z",
        startedAt: "2026-09-04T15:00:01.000Z",
        completedAt: null,
      },
      session: {
        status: "running",
        activeTurnId: turnId,
        updatedAt: "2026-09-04T15:00:01.000Z",
      },
      activities: [
        { kind: "tool.started", turnId, createdAt: "2026-09-04T15:00:03.000Z" },
      ],
    };

    assert.equal(
      normalizeTranscript({ ...snapshot(running), thread: { ...activeThread, session: { ...activeThread.session, status: "ready" } } }).liveActivity,
      null,
    );
    assert.equal(
      normalizeTranscript({ ...snapshot(running), thread: { ...activeThread, latestTurn: { ...activeThread.latestTurn, state: "completed" } } }).liveActivity,
      null,
    );
    assert.equal(
      normalizeTranscript({ ...snapshot(running), thread: { ...activeThread, session: { ...activeThread.session, activeTurnId: "different-turn" } } }).liveActivity,
      null,
    );
    assert.deepEqual(
      normalizeTranscript({ ...snapshot(running), thread: { ...activeThread, session: { ...activeThread.session, status: "ready" } } }).liveActivities,
      [],
    );
  });

  it("keeps only the validated authoritative assistant message after the latest turn settles", () => {
    const settled = thread("settled-live", "2026-09-04T15:00:10.000Z");
    const turnId = "turn-latest";
    const base = snapshot(settled).thread;
    const messages = [
      ...base.messages,
      {
        id: "latest-user",
        role: "user" as const,
        text: "New request",
        turnId,
        streaming: false,
        createdAt: "2026-09-04T15:00:00.000Z",
        updatedAt: "2026-09-04T15:00:00.000Z",
      },
      {
        id: "temporary-progress",
        role: "assistant" as const,
        text: "Temporary progress",
        turnId,
        streaming: false,
        createdAt: "2026-09-04T15:00:01.000Z",
        updatedAt: "2026-09-04T15:00:01.000Z",
      },
      {
        id: "authoritative-final",
        role: "assistant" as const,
        text: "Final answer",
        turnId,
        streaming: false,
        createdAt: "2026-09-04T15:00:02.000Z",
        updatedAt: "2026-09-04T15:00:10.000Z",
      },
      {
        id: "latest-system",
        role: "system" as const,
        text: "System record",
        turnId,
        streaming: false,
        createdAt: "2026-09-04T15:00:03.000Z",
        updatedAt: "2026-09-04T15:00:03.000Z",
      },
    ];
    const result = normalizeTranscript({
      ...snapshot(settled),
      thread: {
        ...base,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:00.000Z",
          completedAt: "2026-09-04T15:00:10.000Z",
          assistantMessageId: "authoritative-final",
        },
        session: { status: "ready", activeTurnId: null, updatedAt: "2026-09-04T15:00:10.000Z" },
        messages,
      },
    });
    const outputMessages = result.turns.flatMap((turn) => turn.messages);

    assert.equal(outputMessages.some((message) => message.id === "temporary-progress"), false);
    assert.equal(outputMessages.some((message) => message.id === "authoritative-final"), true);
    assert.equal(outputMessages.some((message) => message.id === "latest-user"), true);
    assert.equal(outputMessages.some((message) => message.id === "latest-system"), true);
    assert.equal(outputMessages.some((message) => message.id === "assistant-1"), true);
  });

  it("fails safely without deleting transcript content for an invalid authoritative message ID", () => {
    const settled = thread("settled-live", "2026-09-04T15:00:10.000Z");
    const turnId = "turn-latest";
    const base = snapshot(settled).thread;
    const messages = [
      ...base.messages,
      {
        id: "temporary-progress",
        role: "assistant" as const,
        text: "Temporary progress",
        turnId,
        streaming: false,
        createdAt: "2026-09-04T15:00:01.000Z",
        updatedAt: "2026-09-04T15:00:01.000Z",
      },
      {
        id: "authoritative-final",
        role: "assistant" as const,
        text: "Final answer",
        turnId,
        streaming: false,
        createdAt: "2026-09-04T15:00:02.000Z",
        updatedAt: "2026-09-04T15:00:10.000Z",
      },
    ];
    for (const assistantMessageId of [undefined, "", " missing ", "x".repeat(201), "missing"]) {
      const result = normalizeTranscript({
        ...snapshot(settled),
        thread: {
          ...base,
          latestTurn: {
            turnId,
            state: "completed",
            requestedAt: "2026-09-04T15:00:00.000Z",
            startedAt: "2026-09-04T15:00:00.000Z",
            completedAt: "2026-09-04T15:00:10.000Z",
            assistantMessageId,
          },
          session: { status: "ready", activeTurnId: null, updatedAt: "2026-09-04T15:00:10.000Z" },
          messages,
        },
      });
      const ids = result.turns.flatMap((turn) => turn.messages.map((message) => message.id));
      assert.equal(ids.includes("temporary-progress"), true);
      assert.equal(ids.includes("authoritative-final"), true);
    }

    const failedTurn = normalizeTranscript({
      ...snapshot(settled),
      thread: {
        ...base,
        latestTurn: {
          turnId,
          state: "failed",
          requestedAt: "2026-09-04T15:00:00.000Z",
          startedAt: "2026-09-04T15:00:00.000Z",
          completedAt: "2026-09-04T15:00:10.000Z",
          assistantMessageId: "authoritative-final",
        },
        session: { status: "ready", activeTurnId: null, updatedAt: "2026-09-04T15:00:10.000Z" },
        messages,
      },
    });
    assert.equal(
      failedTurn.turns.flatMap((turn) => turn.messages).some((message) => message.id === "temporary-progress"),
      true,
    );
  });

  it("filters deleted projects and their sessions", () => {
    const deleted = { ...project, id: "deleted-project", deletedAt: "2026-09-03T00:00:00Z" };
    const result = normalizeSessions(
      { ...shell, projects: [project, deleted], threads: [...shell.threads, { ...thread("hidden", "2026-09-05T00:00:00Z"), projectId: deleted.id }] },
      config(),
    );
    assert.equal(result.unsettled.some((value) => value.id === "hidden"), false);
  });

  it("orders projects by latest user interaction, ignoring completion and metadata edits", () => {
    const projects = ['old', 'recent', 'empty', 'tie'].map((id) => ({ ...project, id, title: id,
      updatedAt: '2026-09-09T00:00:00Z' }));
    const threads = [
      { ...thread('old-thread', '2026-09-08T00:00:00Z'), projectId: 'old',
        latestUserMessageAt: '2026-09-03T00:00:00Z', latestTurn: { turnId: 'old-turn', state: 'completed',
          requestedAt: '2026-09-03T00:00:00Z', startedAt: '2026-09-03T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' } },
      { ...thread('recent-thread', '2026-09-04T00:00:00Z'), projectId: 'recent',
        latestUserMessageAt: '2026-09-05T00:00:00Z', latestTurn: null },
      { ...thread('tie-thread', '2026-09-04T00:00:00Z'), projectId: 'tie',
        latestUserMessageAt: '2026-09-05T00:00:00Z', latestTurn: null },
    ];
    assert.deepEqual(normalizeProjects({ ...shell, projects, threads }, config()).map(p => p.id),
      ['recent', 'tie', 'old', 'empty']);
    assert.deepEqual(normalizeProjects({ ...shell, projects, threads }, config({ projectIds: new Set(['old', 'empty']) })).map(p => p.id),
      ['old', 'empty']);
  });

  it("allows a visible project to start with a chosen live model without a stored default", () => {
    const withoutDefault = { ...project, defaultModelSelection: null };
    const result = normalizeProjects(
      { ...shell, projects: [withoutDefault] },
      config(),
    );
    assert.deepEqual(result, [
      {
        id: project.id,
        title: project.title,
        canStartSession: true,
        updatedAt: project.updatedAt,
      },
    ]);
  });
});

// Origins the Even Hub bridge accepted; none may reach this bridge.
const evenOrigins = ["http://127.0.0.1", "http://127.0.0.1:1", "http://127.0.0.1:80", "http://127.0.0.1:43751", "http://127.0.0.1:65535"];

async function pair(base: string, passphrase: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/faceclaw/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ passphrase }),
  });
}

describe("HTTP boundary", () => {
  it("rejects every browser origin before authentication or T3 access", async () => {
    const { base, client } = await startServer();
    for (const response of [
      await fetch(`${base}/health`, { headers: { Origin: BROWSER_ORIGIN } }),
      await fetch(`${base}/v1/status`, { headers: { Origin: BROWSER_ORIGIN, Authorization: `Bearer ${BRIDGE_TOKEN}` } }),
      ...await Promise.all([BROWSER_ORIGIN, "null", ...evenOrigins].map((origin) => pair(base, "passphrase", { Origin: origin }))),
    ]) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal((await response.text()).includes(NATIVE_TOKEN), false);
    }
    assert.equal(client.shellCalls, 0);
  });

  it("rejects missing owner auth before touching T3 and returns a safe error", async () => {
    const { base, client } = await startServer();
    const response = await fetch(`${base}/v1/status`);
    assert.equal(response.status, 401);
    assert.equal(client.shellCalls, 0);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.deepEqual(body.error, { code: "unauthorized", message: "Authentication required" });
  });

  it("exchanges the passphrase for a native token that cannot act as the owner", async () => {
    const { base } = await startServer();
    const paired = await pair(base, "passphrase");
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get("cache-control"), "no-store");
    const { token } = (await paired.json()) as { token: string };
    assert.equal(token, NATIVE_TOKEN);
    assert.notEqual(token, BRIDGE_TOKEN);
    const owner = await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(owner.status, 401);
  });

  it("returns the same generic failure for a wrong or disabled passphrase", async () => {
    const wrongServer = await startServer();
    const wrong = await pair(wrongServer.base, "wrong-passphrase");
    assert.equal(wrong.status, 401);
    const wrongBody = await wrong.text();
    assert.equal(wrongBody.includes("wrong-passphrase"), false);
    assert.equal(wrongBody.includes(NATIVE_TOKEN), false);
    assert.match(wrongBody, /"code":"pairing_failed","message":"Pairing failed"/);

    const disabledServer = await startServer(new FakeT3Client(), new FakeTranscriber(), { bridgePassphrase: null });
    const disabled = await pair(disabledServer.base, "wrong-passphrase");
    assert.equal(disabled.status, 401);
    const disabledBody = (await disabled.json()) as { error: unknown };
    assert.deepEqual(disabledBody.error, (JSON.parse(wrongBody) as { error: unknown }).error);
  });

  it("rate limits pairing independently after five attempts", async () => {
    const { base } = await startServer();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await pair(base, "wrong")).status, 401);
    }
    const limited = await pair(base, "passphrase");
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /"code":"pairing_failed","message":"Pairing failed"/);
  });

  it("rejects pairing bodies over the dedicated size limit", async () => {
    const { base } = await startServer();
    const response = await pair(base, "x".repeat(2048));
    assert.equal(response.status, 413);
    const body = await response.text();
    assert.equal(body.includes("passphrase"), false);
    assert.equal(body.includes(NATIVE_TOKEN), false);
  });

  it("has no Even Hub pairing, REST session or phone companion routes", async () => {
    const { base, client } = await startServer();
    const owner = { Authorization: `Bearer ${BRIDGE_TOKEN}`, "Content-Type": "application/json" };
    for (const [method, path] of [["POST", "/v1/pair"], ["GET", "/v1/sessions"], ["POST", "/v1/sessions"],
      ["GET", "/v1/projects"], ["POST", "/v1/phone/pair"], ["POST", "/v1/phone/sync"]] as const) {
      const response = await fetch(`${base}${path}`, { method, headers: owner, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 404, path);
      await response.json();
    }
    assert.equal(client.shellCalls + client.starts.length, 0);
  });
});

describe("WebSocket RPC and voice boundary", () => {
  it("settles only an authenticated, allowed, currently idle thread without sending a turn", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    const response = await rpc(socket, "settle", "thread.settle", { threadId: "older" });
    assert.deepEqual(response.result, { threadId: "older", settled: true, sequence: 10 });
    assert.deepEqual(client.settlements, ["older"]);
    assert.equal(client.starts.length + client.sends.length + client.steers.length, 0);
    socket.close();
  });

  it("rejects malformed settlement parameters before any upstream read or mutation", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    for (const [index, params] of [{ threadId: "../older" }, { threadId: "older", settled: false },
      { threadId: "older", projectId: project.id }, { threadId: 1 }, {}].entries()) {
      const response = await rpc(socket, `settle-invalid-${index}`, "thread.settle", params);
      assert.equal((response.error as Record<string, unknown>).code, "invalid_request");
    }
    assert.equal(client.shellCalls, 0);
    assert.deepEqual(client.settlements, []);
    socket.close();
  });

  it("enforces project scope and rejects missing, archived, or deleted-project sessions", async () => {
    const variants = [
      { shell, overrides: { projectIds: new Set(["other-project"]) }, id: "older" },
      { shell, overrides: {}, id: "missing" },
      { shell: { ...shell, threads: [{ ...shell.threads[0]!, archivedAt: shell.updatedAt }] }, overrides: {}, id: "older" },
      { shell: { ...shell, projects: [{ ...project, deletedAt: shell.updatedAt }] }, overrides: {}, id: "older" },
    ];
    for (const entry of variants) {
      const client = new FakeT3Client(entry.shell);
      const { base } = await startServer(client, new FakeTranscriber(), entry.overrides);
      const socket = await openSocket(base);
      const response = await rpc(socket, "settle-forbidden", "thread.settle", { threadId: entry.id });
      assert.equal((response.error as Record<string, unknown>).code, "not_found");
      assert.deepEqual(client.settlements, []);
      socket.close();
    }
  });

  it("fails closed for working, pending-input, unknown, and freshly changed session states", async () => {
    const idle = shell.threads[0]!;
    const now = shell.updatedAt;
    const variants = [
      { ...idle, session: { status: "running", updatedAt: now } },
      { ...idle, session: { status: "starting", updatedAt: now } },
      { ...idle, hasPendingUserInput: true },
      { ...idle, session: { status: "ready", activeTurnId: "active", updatedAt: now } },
      { ...idle, latestTurn: { turnId: "active", state: "running", requestedAt: now, startedAt: now, completedAt: null } },
      { ...idle, session: { status: "future-status", updatedAt: now } },
      { ...idle, session: undefined } as unknown as T3ThreadShell,
      { ...idle, latestTurn: undefined } as unknown as T3ThreadShell,
    ];
    for (const [index, changed] of variants.entries()) {
      // The browser and shell may both still show idle; the fresh thread wins.
      const client = new FakeT3Client();
      client.thread = async () => snapshot(changed);
      const { base } = await startServer(client);
      const socket = await openSocket(base);
      const response = await rpc(socket, `settle-race-${index}`, "thread.settle", { threadId: idle.id });
      assert.equal(response.ok, false);
      assert.equal((response.error as Record<string, unknown>).code,
        index < 5 ? "session_busy" : "upstream_invalid_response");
      assert.deepEqual(client.settlements, []);
      socket.close();
    }
  });

  it("rejects swapped upstream thread identities and unsupported settlement capabilities", async () => {
    for (const kind of ["thread", "project", "archived", "unsupported"] as const) {
      const client = new FakeT3Client();
      client.thread = async () => snapshot({ ...shell.threads[0]!,
        ...(kind === "thread" ? { id: "newer" } : {}),
        ...(kind === "project" ? { projectId: "private-project" } : {}),
        ...(kind === "archived" ? { archivedAt: shell.updatedAt } : {}),
      });
      if (kind === "unsupported") client.descriptor = async () => ({
        environmentId: "environment", label: "Legacy", serverVersion: "legacy", capabilities: {},
      });
      const { base } = await startServer(client);
      const socket = await openSocket(base);
      const response = await rpc(socket, `settle-${kind}`, "thread.settle", { threadId: "older" });
      assert.equal(response.ok, false);
      assert.deepEqual(client.settlements, []);
      socket.close();
    }
  });

  it("never reports settlement success after upstream rejects a concurrent turn", async () => {
    const client = new FakeT3Client();
    client.settleThread = async () => { throw new Error("private upstream blocking request details"); };
    const { base } = await startServer(client);
    const socket = await openSocket(base);
    const response = await rpc(socket, "settle-upstream-race", "thread.settle", { threadId: "older" });
    assert.equal(response.ok, false);
    assert.deepEqual(response.error, { code: "internal_error", message: "The bridge could not complete the request" });
    assert.equal(JSON.stringify(response).includes("private upstream"), false);
    socket.close();
  });

  it("validates plan requests through authenticated RPC and forwards one complete batch only", async () => {
    const now = "2026-09-04T12:00:00.000Z";
    const active = { ...thread("plan-thread", now), interactionMode: "plan" as const,
      latestTurn: { turnId: "turn", state: "running", requestedAt: now, startedAt: now, completedAt: null },
      session: { status: "running", activeTurnId: "turn", updatedAt: now }, messages: [],
      activities: [{ kind: "user-input.requested", turnId: "turn", createdAt: now,
        payload: { requestId: "request", questions: [{ id: "choice", header: "Choose", question: "Which option?",
          options: [{ label: "One", description: "First option" }], multiSelect: false }] } }] };
    const client = new FakeT3Client({ ...shell, threads: [active] });
    client.thread = async () => ({ snapshotSequence: 7, thread: active });
    const { base } = await startServer(client);
    const socket = await openSocket(base);
    const pending = normalizePendingPlanInput(active)!;
    const transcript = await rpc(socket, "plan-transcript", "transcript.get", { threadId: active.id });
    assert.deepEqual((transcript.result as Record<string, unknown>).pendingPlanInput, pending);
    const params = { threadId: active.id, requestId: pending.requestId, revision: pending.revision,
      answers: [{ questionId: "choice", optionIndexes: [0], text: "" }] };
    const invalid = await rpc(socket, "plan-partial", "plan.submit", { ...params, answers: [] });
    assert.equal((invalid.error as Record<string, unknown>).code, "invalid_plan_answers");
    assert.equal(client.planSubmissions.length, 0);
    assert.equal((await rpc(socket, "plan-valid", "plan.submit", params)).ok, true);
    assert.equal((await rpc(socket, "plan-again", "plan.submit", params)).ok, true);
    assert.equal(client.planSubmissions.length, 1);
    assert.equal(client.starts.length + client.sends.length + client.steers.length, 0);
    socket.close();
  });
  it("keeps unregistered service methods unavailable through an authenticated socket", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    for (const method of ["rss.read", "weather.fetch", "weather.constructor", "weather.current.extra"]) {
      const response = await rpc(socket, method, method, { url: "https://attacker.example/feed" });
      assert.equal(response.ok, false);
      assert.deepEqual(response.error, { code: "method_not_found", message: "Method not found" });
    }
    assert.equal(client.starts.length, 0);
    assert.equal(client.sends.length, 0);
    socket.close();
  });
  it("routes weather methods only through the authenticated RPC boundary and rejects malformed inputs", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    for (const [method, params] of [
      ["weather.current", { latitude: 999, longitude: 0 }],
      ["weather.locations", { query: "x" }],
    ] as const) {
      const response = await rpc(socket, method, method, params);
      assert.equal(response.ok, false);
      assert.deepEqual(response.error, { code: "invalid_request", message: method === "weather.current"
        ? "Weather coordinates are invalid" : "Enter a city name between 2 and 100 characters" });
    }
    assert.equal(client.starts.length, 0);
    assert.equal(client.sends.length, 0);
    socket.close();
  });
  it("authenticates by subprotocol without echoing the secret protocol", async () => {
    const { base } = await startServer();
    const socket = await openSocket(base);
    assert.equal(socket.protocol, "even-t3-v1");
    socket.close();
  });

  it("accepts only the native token on the native socket without a browser origin", async () => {
    const { base } = await startServer();
    const ws = base.replace(/^http/, "ws");
    for (const [path, token, origin] of [
      ["/v1/faceclaw/events", NATIVE_TOKEN, BROWSER_ORIGIN],
      ["/v1/faceclaw/events", BRIDGE_TOKEN, undefined],
      ["/v1/events", NATIVE_TOKEN, undefined],
      ["/v1/events", BRIDGE_TOKEN, BROWSER_ORIGIN],
    ] as const) {
      const socket = new WebSocket(ws + path, ["even-t3-v1", `auth.${token}`], origin ? { origin } : {});
      const status = await new Promise<number>((resolve) => {
        socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      });
      assert.equal(status, 401, path);
    }
  });

  it("returns a flat model catalog without T3 option or account details", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    const response = await rpc(socket, "models", "models.list", {});
    assert.equal(response.ok, true);
    assert.equal(client.catalogCalls, 1);
    assert.deepEqual(response.result, {
      models: [
        {
          instanceId: "codex",
          providerName: "Codex Personal",
          model: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          isDefault: true,
          reasoningChoices: [
            { id: "low", label: "Low", isDefault: false },
            { id: "medium", label: "Medium", isDefault: true },
          ],
        },
      ],
    });
    assert.equal(JSON.stringify(response.result).includes("reasoningEffort"), false);
    assert.equal(JSON.stringify(response.result).includes("t3-secret"), false);
    socket.close();
  });

  it("finishes bounded PCM as a draft without sending it to T3", async () => {
    const { base, client, transcriber } = await startServer();
    const socket = await openSocket(base);
    const started = await rpc(socket, "1", "voice.start", {});
    assert.equal(started.ok, true);
    socket.send(Buffer.alloc(3200), { binary: true });
    const finished = await rpc(socket, "2", "voice.finish", {});
    assert.equal(finished.ok, true);
    assert.deepEqual(finished.result, { text: "dictated request" });
    assert.equal(transcriber.calls, 1);
    assert.equal(client.starts.length, 0);
    assert.equal(client.sends.length, 0);
    const sent = await rpc(socket, "3", "thread.start", {
      projectId: project.id,
      text: "dictated request",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        reasoningId: "medium",
      },
    });
    assert.equal(sent.ok, true);
    assert.equal(client.starts.length, 1);
    assert.equal(client.starts[0]?.text, "dictated request");
    assert.equal(client.starts[0]?.runtimeMode, "full-access");
    assert.deepEqual(client.starts[0]?.selection, {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      reasoningId: "medium",
    });
    socket.close();
  });

  it("discards absent or short audio so the next recording can start without a cancel", async () => {
    const { base, client, transcriber } = await startServer();
    const socket = await openSocket(base);
    for (const bytes of [0, 100]) {
      assert.equal((await rpc(socket, `start-${bytes}`, "voice.start", {})).ok, true);
      if (bytes) socket.send(Buffer.alloc(bytes, 7), { binary: true });
      const finished = await rpc(socket, `finish-${bytes}`, "voice.finish", {});
      assert.equal(finished.ok, false);
      assert.equal((finished.error as { code: string }).code, "no_speech");
      assert.deepEqual((await rpc(socket, `cancel-${bytes}`, "voice.cancel", {})).result, { cancelled: false });
    }
    assert.equal((await rpc(socket, "retry", "voice.start", {})).ok, true);
    assert.equal(transcriber.calls, 0);
    assert.equal(client.starts.length + client.sends.length + client.steers.length, 0);
    socket.close();
  });

  it("rejects blank transcription and wipes the recording before another attempt", async () => {
    const { base, client, transcriber } = await startServer();
    let captured: readonly Buffer[] = [];
    transcriber.transcribe = async (pcm) => { captured = [...pcm]; return " \n\t "; };
    const socket = await openSocket(base);
    await rpc(socket, "start", "voice.start", {});
    socket.send(Buffer.alloc(3200, 7), { binary: true });
    const finished = await rpc(socket, "finish", "voice.finish", {});
    assert.equal(finished.ok, false);
    assert.equal((finished.error as { code: string }).code, "no_speech");
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], Buffer.alloc(3200));
    assert.equal((await rpc(socket, "retry", "voice.start", {})).ok, true);
    assert.equal(client.starts.length + client.sends.length + client.steers.length, 0);
    socket.close();
  });

  it("rejects empty text at every T3 send boundary even if the client bypasses draft checks", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    const before = client.shellCalls;
    for (const method of ["thread.start", "assistant.start", "turn.send", "turn.steer"]) {
      const params = method.endsWith(".start")
        ? { projectId: project.id, modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" }, text: " \n\t " }
        : { threadId: "older", text: " \n\t " };
      const result = await rpc(socket, method, method, params);
      assert.equal(result.ok, false);
      assert.equal((result.error as { code: string }).code, "invalid_request");
    }
    assert.equal(client.shellCalls, before);
    assert.equal(client.starts.length + client.sends.length + client.steers.length, 0);
    socket.close();
  });

  it("starts every new session with full access regardless of legacy config and preserves existing thread permissions", async () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
      const { base, client } = await startServer(new FakeT3Client(), new FakeTranscriber(), { runtimeMode });
      const socket = await openSocket(base);
      const params = { projectId: project.id, text: "Explicitly sent draft",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", reasoningId: "medium" } };
      for (const method of ["assistant.start", "thread.start"]) {
        assert.equal((await rpc(socket, method, method, params)).ok, true);
      }
      // Older ordinary clients may send a mode; it cannot override the server policy.
      assert.equal((await rpc(socket, "override", "thread.start", { ...params, runtimeMode: "approval-required" })).ok, true);
      assert.equal(client.starts.length, 3);
      for (const started of client.starts) {
        assert.equal(started.runtimeMode, "full-access");
        assert.deepEqual(started.selection, params.modelSelection);
        assert.equal(started.project.id, project.id);
      }
      assert.equal((await rpc(socket, "override-followup", "turn.send", { threadId: "older", text: "Follow up", runtimeMode: "full-access" })).ok, false);
      assert.equal((await rpc(socket, "followup", "turn.send", { threadId: "older", text: "Follow up" })).ok, true);
      assert.equal(client.sends[0]?.thread.runtimeMode, "approval-required");
      socket.close();
    }
  });

  it("rejects assistant permission overrides, malformed selections, and empty drafts before any T3 access", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    const params = { projectId: project.id, text: "Do not send",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } };
    for (const [index, invalid] of [
      { ...params, runtimeMode: "full-access" },
      { ...params, threadId: "older" },
      { ...params, workspaceRoot: "/different/project" },
      { ...params, modelSelection: { ...params.modelSelection, options: [{ id: "approvalPolicy", value: "never" }] } },
      { ...params, text: " " },
    ].entries()) {
      assert.equal((await rpc(socket, `invalid-${index}`, "assistant.start", invalid)).ok, false);
    }
    assert.equal(client.shellCalls, 0);
    assert.equal(client.starts.length, 0);
    socket.close();
  });

  it("retains project allowlisting and rejects deleted or missing projects for every new session method", async () => {
    for (const blocked of ["allowlist", "deleted", "missing"] as const) {
      const client = new FakeT3Client({ ...shell, projects: blocked === "deleted"
        ? [{ ...project, deletedAt: "2026-09-05T00:00:00.000Z" }] : blocked === "missing" ? [] : [project] });
      const { base } = await startServer(client, new FakeTranscriber(),
        blocked === "allowlist" ? { projectIds: new Set(["another-project"]) } : {});
      const socket = await openSocket(base);
      const params = { projectId: project.id, text: "Do not send",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } };
      for (const method of ["assistant.start", "thread.start"]) {
        const result = await rpc(socket, `${blocked}-${method}`, method, params);
        assert.equal(result.ok, false);
        assert.deepEqual(result.error, { code: "not_found", message: "Project not found" });
      }
      assert.equal(client.starts.length, 0);
      socket.close();
    }
  });

  it("rejects malformed model selections before reading or writing T3 state", async () => {
    const { base, client } = await startServer();
    const socket = await openSocket(base);
    const malformed = await rpc(socket, "bad-model", "thread.start", {
      projectId: project.id,
      text: "must not send",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        reasoningId: "medium",
        injectedOption: "fast",
      },
    });
    assert.equal(malformed.ok, false);
    assert.deepEqual(malformed.error, {
      code: "invalid_request",
      message: "modelSelection contains unsupported fields",
    });
    assert.equal(client.shellCalls, 0);
    assert.equal(client.starts.length, 0);

    const missing = await rpc(socket, "missing-model", "thread.start", {
      projectId: project.id,
      text: "must not send",
    });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.error, {
      code: "invalid_request",
      message: "modelSelection must be an object",
    });
    assert.equal(client.shellCalls, 0);
    assert.equal(client.starts.length, 0);
    socket.close();
  });

  it("steers only an authenticated running or starting session", async () => {
    for (const status of ["running", "starting"] as const) {
      const active = {
        ...thread(`active-${status}`, "2026-09-04T15:00:00.000Z"),
        session: {
          status,
          activeTurnId: "turn-active",
          updatedAt: "2026-09-04T15:00:00.000Z",
        },
      };
      const client = new FakeT3Client({
        ...shell,
        threads: [...shell.threads, active],
      });
      const { base } = await startServer(client);
      const socket = await openSocket(base);
      const response = await rpc(socket, `steer-${status}`, "turn.steer", {
        threadId: active.id,
        text: `Steer while ${status}`,
      });

      assert.equal(response.ok, true);
      assert.deepEqual(response.result, {
        threadId: active.id,
        text: `Steer while ${status}`,
        sequence: 9,
      });
      assert.deepEqual(client.steers, [{ thread: active, text: `Steer while ${status}` }]);
      assert.equal(client.sends.length, 0);
      socket.close();
    }
  });

  it("rejects steering an idle session without dispatching a turn", async () => {
    const client = new FakeT3Client();
    const { base } = await startServer(client);
    const socket = await openSocket(base);
    const response = await rpc(socket, "steer-idle", "turn.steer", {
      threadId: "older",
      text: "Must not become a fresh turn",
    });

    assert.equal(response.ok, false);
    assert.deepEqual(response.error, {
      code: "session_not_running",
      message: "The session is no longer running",
    });
    assert.equal(client.steers.length, 0);
    assert.equal(client.sends.length, 0);
    socket.close();
  });

  it("reviews a reply against the live thread and accepts both active and newly idle sessions", async () => {
    for (const status of ["running", "idle"] as const) {
      const candidate = {
        ...thread(`reply-${status}`, "2026-09-04T15:00:00.000Z"),
        session: status === "running" ? {
          status: "running",
          activeTurnId: "turn-active",
          updatedAt: "2026-09-04T15:00:00.000Z",
        } : null,
      };
      const client = new FakeT3Client({ ...shell, threads: [...shell.threads, candidate] });
      const { base } = await startServer(client);
      const socket = await openSocket(base);
      const response = await rpc(socket, `reply-${status}`, "turn.reply", {
        threadId: candidate.id,
        text: `Reviewed while ${status}`,
      });
      assert.equal(response.ok, true);
      assert.deepEqual(response.result, {
        threadId: candidate.id,
        text: `Reviewed while ${status}`,
        sequence: 10,
      });
      assert.equal(client.replies.length, 1);
      assert.equal(client.replies[0]?.thread.id, candidate.id);
      assert.equal(client.replies[0]?.text, `Reviewed while ${status}`);
      socket.terminate();
    }
  });

  it("rejects a reviewed reply for a missing or archived session without dispatch", async () => {
    for (const candidate of [
      { ...thread("missing", "2026-09-04T15:00:00.000Z") },
      { ...thread("archived", "2026-09-04T15:00:00.000Z"), archivedAt: "2026-09-04T15:00:00.000Z" },
    ]) {
      const client = new FakeT3Client({ ...shell, threads: candidate.id === "missing" ? shell.threads : [...shell.threads, candidate] });
      const { base } = await startServer(client);
      const socket = await openSocket(base);
      const response = await rpc(socket, `missing-${candidate.id}`, "turn.reply", { threadId: candidate.id, text: "Do not send" });
      assert.equal(response.ok, false);
      assert.equal((response.error as { code: string }).code, "not_found");
      assert.equal(client.replies.length, 0);
      socket.terminate();
    }
  });

  it("rejects malformed steering input before reading or writing T3 state", async () => {
    const client = new FakeT3Client();
    const { base } = await startServer(client, new FakeTranscriber(), { maxTextChars: 16 });
    const socket = await openSocket(base);
    const badId = await rpc(socket, "steer-bad-id", "turn.steer", {
      threadId: "../older",
      text: "steer",
    });
    const oversized = await rpc(socket, "steer-big", "turn.steer", {
      threadId: "older",
      text: "x".repeat(17),
    });

    assert.equal(badId.ok, false);
    assert.deepEqual(badId.error, {
      code: "invalid_request",
      message: "threadId must be a valid identifier",
    });
    assert.equal(oversized.ok, false);
    assert.deepEqual(oversized.error, {
      code: "text_too_large",
      message: "text cannot exceed 16 characters",
    });
    assert.equal(client.shellCalls, 0);
    assert.equal(client.steers.length, 0);
    socket.close();
  });

  it("notifies a subscribed client of a transcript snapshot change without transcript text", async () => {
    const client = new FakeT3Client();
    const { base } = await startServer(client, new FakeTranscriber(), {
      pollIntervalMs: 10,
    });
    const socket = await openSocket(base);
    const transcript = await rpc(socket, "subscribe", "transcript.get", {
      threadId: "older",
    });
    assert.equal(transcript.ok, true);

    const changed = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Transcript change timed out")), 2000);
      const listener = (raw: WebSocket.RawData) => {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (value.type === "event" && value.event === "transcript.changed") {
          clearTimeout(timeout);
          socket.off("message", listener);
          resolve(value);
        }
      };
      socket.on("message", listener);
    });
    client.threadSequence = 8;

    const event = await changed;
    assert.deepEqual(event.payload, { threadId: "older", snapshotId: "8" });
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("Do the work"), false);
    assert.equal(serialized.includes("Done"), false);
    assert.equal(serialized.includes("turns"), false);
    socket.close();
  });

  it("announces background work changes that T3 keeps outside the shell sequence", async () => {
    const client = new FakeT3Client(structuredClone(shell));
    const { base } = await startServer(client, new FakeTranscriber(), { pollIntervalMs: 10 });
    const socket = await openSocket(base);
    const nextSessionsChange = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sessions change timed out")), 2000);
      const listener = (raw: WebSocket.RawData) => {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (value.type === "event" && value.event === "sessions.changed") {
          clearTimeout(timeout);
          socket.off("message", listener);
          resolve(value);
        }
      };
      socket.on("message", listener);
    });
    await nextSessionsChange();
    const sequence = client.shellSnapshot.snapshotSequence;
    for (const [liveness, expected] of [["working", "subagents"], ["monitoring", "monitoring"], [null, null]] as const) {
      const changed = nextSessionsChange();
      client.shellSnapshot = { ...client.shellSnapshot, snapshotSequence: sequence,
        threads: client.shellSnapshot.threads.map((item) => item.id === "older" ? { ...item, backgroundLiveness: liveness } : item) };
      const payload = (await changed).payload as { unsettled: Array<{ id: string; background: unknown }> };
      assert.equal(payload.unsettled.find((item) => item.id === "older")?.background, expected);
    }
    socket.close();
  });

  it("emits a bounded live transcription draft while capture stays active", async () => {
    const { base, transcriber } = await startServer();
    const socket = await openSocket(base);
    await rpc(socket, "1", "voice.start", {});
    const partial = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Partial transcription timed out")), 2000);
      const listener = (raw: WebSocket.RawData) => {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (value.type === "event" && value.event === "voice.partial") {
          clearTimeout(timeout);
          socket.off("message", listener);
          resolve(value);
        }
      };
      socket.on("message", listener);
    });
    socket.send(Buffer.alloc(3200), { binary: true });
    const event = await partial;
    assert.deepEqual(event.payload, { text: "dictated request" });
    assert.equal(transcriber.calls, 1);
    const cancelled = await rpc(socket, "2", "voice.cancel", {});
    assert.deepEqual(cancelled.result, { cancelled: true });
    socket.close();
  });

  it("rejects odd-byte PCM and allows a clean cancel", async () => {
    const { base, transcriber } = await startServer();
    const socket = await openSocket(base);
    await rpc(socket, "1", "voice.start", {});
    socket.send(Buffer.alloc(3), { binary: true });
    const cancelled = await rpc(socket, "2", "voice.cancel", {});
    assert.equal(cancelled.ok, true);
    assert.deepEqual(cancelled.result, { cancelled: true });
    assert.equal(transcriber.calls, 0);
    socket.close();
  });
});

describe("WAV encoding", () => {
  it("writes a PCM s16le 16 kHz mono header without touching the source", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = pcmToWav([pcm]);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 4);
    assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
    assert.deepEqual([...pcm], [1, 2, 3, 4]);
  });
});

describe("local Whisper boundary", () => {
  it("rejects empty, silent, and stuck PCM without letting Whisper invent a draft", async () => {
    let requests = 0;
    const whisperServerUrl = await startLocalWhisper((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ text: "Invented speech" }));
    });
    const transcriber = new WhisperCppTranscriber(config({ whisperServerUrl }));
    for (const pcm of [[], [Buffer.alloc(3200)], [Buffer.alloc(1600, 7), Buffer.alloc(1600, 7)]]) {
      const originals = pcm.map((chunk) => Buffer.from(chunk));
      await assert.rejects(transcriber.transcribe(pcm, new AbortController().signal), { code: "no_speech" });
      assert.deepEqual(pcm, originals);
    }
    assert.equal(requests, 0);
  });

  it("rejects whitespace-only Whisper output for a changing audio signal", async () => {
    const whisperServerUrl = await startLocalWhisper((_request, response) => {
      response.end(JSON.stringify({ text: " \n\t " }));
    });
    const transcriber = new WhisperCppTranscriber(config({ whisperServerUrl }));
    await assert.rejects(transcriber.transcribe([Buffer.from([0, 0, 1, 0])], new AbortController().signal), { code: "no_speech" });
  });

  it("sends only bounded WAV to loopback and accepts a bounded JSON draft", async () => {
    let requestBody = Buffer.alloc(0);
    const whisperServerUrl = await startLocalWhisper((request, response) => {
      assert.equal(request.url, "/inference");
      assert.equal(request.method, "POST");
      assert.match(request.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
      assert.equal(request.headers.authorization, undefined);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ text: "  local draft  " }));
      });
    });
    const pcm = Buffer.alloc(3200);
    pcm.writeInt16LE(1, 100); // Changing signal at very low amplitude remains eligible.
    const transcriber = new WhisperCppTranscriber(config({ whisperServerUrl }));
    const text = await transcriber.transcribe([pcm], new AbortController().signal);
    assert.equal(text, "local draft");
    assert.equal(requestBody.includes(Buffer.from("RIFF")), true);
    assert.equal(pcm.readInt16LE(100), 1);
  });

  it("maps cancellation to a safe error without returning the local server response", async () => {
    const transcriber = new WhisperCppTranscriber(config());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      transcriber.transcribe([Buffer.alloc(3200)], controller.signal),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Dictation was cancelled" &&
        !error.message.includes("127.0.0.1"),
    );
  });
});
