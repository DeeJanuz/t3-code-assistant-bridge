import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { ApiError } from "../src/security.js";
import { HttpT3Client } from "../src/t3-client.js";
import type { BridgeConfig, T3Project } from "../src/types.js";

const T3_ACCESS_TOKEN = "t3-test-secret";
const servers: Server[] = [];

afterEach(async () => {
  const active = servers.splice(0);
  for (const server of active) server.closeAllConnections();
  await Promise.all(
    active.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** An RPC answer that T3 reports as a typed failure, as `orchestration.dispatchCommand` does. */
class RpcFailure {
  constructor(readonly detail: string) {}
}

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
type RpcHandler = (request: Record<string, unknown>) => unknown | Promise<unknown>;

function notFound(): HttpHandler {
  return async (_request, response) => { response.writeHead(404).end(); };
}

/**
 * A fake T3 V2 server. Orchestration reads require the protocol header and
 * the websocket requires the protocol query parameter, as the real server does.
 */
async function startUpstream(handler: HttpHandler, rpcHandler: RpcHandler | null = () => providerConfig()): Promise<URL> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/orchestration/") && request.headers["x-t3-orchestration-protocol"] !== "2") {
      response.writeHead(400).end();
      return;
    }
    void handler(request, response).catch((error: unknown) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://upstream.invalid");
    if (url.pathname !== "/ws" || request.headers.authorization !== `Bearer ${T3_ACCESS_TOKEN}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.searchParams.get("orchestrationProtocol") !== "2") {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      if (rpcHandler === null) return;
      websocket.on("message", (data) => {
        const rpcRequest = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        void Promise.resolve(rpcHandler(rpcRequest)).then((value) => {
          websocket.send(JSON.stringify({
            _tag: "Exit",
            requestId: rpcRequest.id,
            exit: value instanceof RpcFailure
              ? { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", message: value.detail } }] }
              : { _tag: "Success", value },
          }));
        });
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}`);
}

/**
 * Records V2 commands. `answer` returns a dispatch result, an `RpcFailure`, or
 * undefined for the next sequence. Model catalog requests get `catalog()`.
 */
function commandRecorder(answer: (command: Record<string, unknown>, index: number) => unknown = () => undefined,
  catalog: () => unknown = () => providerConfig()) {
  const commands: Record<string, unknown>[] = [];
  const rpc: RpcHandler = (request) => {
    if (request.tag === "server.getConfig") return catalog();
    assert.equal(request.tag, "orchestration.dispatchCommand");
    const command = request.payload as Record<string, unknown>;
    commands.push(command);
    return answer(command, commands.length - 1) ?? { sequence: commands.length };
  };
  return { commands, rpc };
}

const RUN_ID = "run:thread:thread-1:ordinal:1";

/** A V2 thread detail snapshot with an optional latest run. */
function v2Detail(thread: Record<string, unknown>, extra: Record<string, unknown> = {}, sequence = 2) {
  return {
    snapshotSequence: sequence,
    projection: {
      thread: { createdBy: "user", creationSource: "web", ...thread },
      runs: [], attempts: [], nodes: [], subagents: [], providerSessions: [], providerThreads: [],
      providerTurns: [], runtimeRequests: [], messages: [], plans: [], turnItems: [],
      checkpointScopes: [], checkpoints: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [],
      updatedAt: thread.updatedAt,
      ...extra,
    },
  };
}

function respondJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function config(t3BaseUrl: URL, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    bridgeToken: "abcdefghijklmnopqrstuvwxyzABCDEF",
    bridgePassphrase: null,
    projectIds: null,
    runtimeMode: "approval-required",
    pollIntervalMs: 60_000,
    rateLimitPerMinute: 1000,
    maxBodyBytes: 16_384,
    maxTextChars: 8000,
    maxUpstreamBytes: 8 * 1024 * 1024,
    upstreamTimeoutMs: 10_000,
    t3BaseUrl,
    t3AccessToken: T3_ACCESS_TOKEN,
    whisperServerUrl: new URL("http://127.0.0.1:8178/inference"),
    whisperLanguage: "en",
    whisperPartialIntervalMs: 1000,
    transcriptionTimeoutMs: 60_000,
    maxVoiceBytes: 9_600_000,
    ...overrides,
  };
}

function providerConfig(): Record<string, unknown> {
  return {
    auth: { private: "must-not-escape" },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex Personal",
        enabled: true,
        installed: true,
        availability: "available",
        status: "ready",
        auth: { status: "authenticated", email: "private@example.com" },
        message: "private provider detail",
        models: [
          {
            slug: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            isDefault: true,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "medium",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
                {
                  id: "serviceTier",
                  label: "Service Tier",
                  type: "select",
                  currentValue: "fast",
                  options: [
                    { id: "default", label: "Standard" },
                    { id: "fast", label: "Fast", isDefault: true },
                  ],
                },
              ],
            },
          },
        ],
      },
      {
        instanceId: "disabled",
        driver: "codex",
        displayName: "Disabled account",
        enabled: false,
        installed: true,
        status: "disabled",
        models: [{ slug: "hidden", name: "Hidden", capabilities: null }],
      },
    ],
  };
}

function project(defaultModelSelection: T3Project["defaultModelSelection"] = {
  instanceId: "codex",
  model: "gpt-5.6-sol",
}): T3Project {
  return {
    id: "project-1",
    title: "Even Realities",
    workspaceRoot: "/private/repository/path",
    defaultModelSelection,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("HttpT3Client session creation", () => {
  it("creates the thread with the requested runtime mode, then dispatches the first message", async () => {
    const { commands, rpc } = commandRecorder();
    const baseUrl = await startUpstream(notFound(), rpc);
    const client = new HttpT3Client(config(baseUrl));
    await client.startSession({ project: project(), threadId: "assistant", text: "Explicit draft",
      runtimeMode: "full-access", selection: { instanceId: "codex", model: "gpt-5.6-sol", reasoningId: "medium" } });
    assert.deepEqual(commands.map((command) => command.type), ["thread.create", "message.dispatch"]);
    assert.equal(commands[0]!.runtimeMode, "full-access");
    assert.equal(commands[0]!.interactionMode, "default");
    assert.equal("runtimeMode" in commands[1]!, false);
  });

  it("sends the exact V2 creation and first-message commands", async () => {
    const { commands, rpc } = commandRecorder((_command, index) => ({ sequence: index + 41 }));
    const baseUrl = await startUpstream(notFound(), rpc);

    const client = new HttpT3Client(config(baseUrl));
    const result = await client.startSession({
      project: project(),
      threadId: "thread-1",
      text: "First line\nmore context",
      runtimeMode: "approval-required",
    });

    assert.equal(result.sequence, 42);
    const modelSelection = {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "default" },
      ],
    };
    assert.deepEqual(commands[0], {
      type: "thread.create",
      commandId: commands[0]!.commandId,
      createdBy: "user",
      creationSource: "mobile",
      threadId: "thread-1",
      projectId: "project-1",
      title: "First line",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    assert.deepEqual(commands[1], {
      type: "message.dispatch",
      commandId: commands[1]!.commandId,
      createdBy: "user",
      creationSource: "mobile",
      threadId: "thread-1",
      messageId: commands[1]!.messageId,
      text: "First line\nmore context",
      attachments: [],
      modelSelection,
      titleSeed: "First line",
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
    assert.notEqual(commands[0]!.commandId, commands[1]!.commandId);
  });

  it("does not dispatch a message when thread creation is rejected", async () => {
    const { commands, rpc } = commandRecorder(() => new RpcFailure(`internal failure using Bearer ${T3_ACCESS_TOKEN}`));
    const baseUrl = await startUpstream(notFound(), rpc);

    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(
      client.startSession({
        project: project(),
        threadId: "thread-1",
        text: "Do not dispatch this turn",
        runtimeMode: "approval-required",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_operation_failed");
        assert.equal(error.message, "T3 Code rejected the operation");
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
    assert.equal(commands.length, 1);
  });

  it("returns a safe error when the first message is rejected after creation", async () => {
    const { commands, rpc } = commandRecorder((command) => command.type === "thread.create"
      ? { sequence: 41 } : new RpcFailure(`internal failure using Bearer ${T3_ACCESS_TOKEN}`));
    const baseUrl = await startUpstream(notFound(), rpc);

    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(
      client.startSession({
        project: project(),
        threadId: "thread-1",
        text: "Start this turn",
        runtimeMode: "approval-required",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_operation_failed");
        assert.equal(error.message, "T3 Code rejected the operation");
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
    assert.deepEqual(commands.map((command) => command.type), ["thread.create", "message.dispatch"]);
  });

  it("rejects projects without a default model before any upstream write", async () => {
    const { commands, rpc } = commandRecorder();
    const baseUrl = await startUpstream(notFound(), rpc);

    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(
      client.startSession({
        project: project(null),
        threadId: "thread-1",
        text: "Cannot run",
        runtimeMode: "approval-required",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "project_model_required");
        return true;
      },
    );
    assert.equal(commands.length, 0);
  });
});

describe("HttpT3Client same-turn steering", () => {
  it("answers questions through runtime-request.respond with T3's option values", async () => {
    const { commands, rpc } = commandRecorder(() => ({ sequence: 74 }));
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.url, "/api/orchestration/threads/thread-1/bounded");
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      respondJson(response, v2Detail({ id: "thread-1" }, { turnItems: [{
        id: "turn-item:request-1", type: "user_input_request", requestId: "request-1", runId: RUN_ID,
        questions: [
          { id: "approach", header: "Approach", question: "Which approach?",
            options: [{ label: "Small", description: "Smaller change", value: "small" }] },
          { id: "features", header: "Features", question: "Which features?", multiSelect: true,
            options: [{ label: "A", description: "First" }, { label: "B", description: "Second", value: "b" }] },
        ],
      }] }));
    }, rpc);
    assert.deepEqual(await new HttpT3Client(config(baseUrl)).respondToPlanInput({
      threadId: "thread-1", requestId: "request-1", commandId: "even-plan-fixture",
      answers: { approach: "Small", features: ["A", "B"], custom: "Typed answer" },
    }), { sequence: 74 });
    assert.deepEqual(commands, [{ type: "runtime-request.respond", commandId: "even-plan-fixture",
      threadId: "thread-1", requestId: "request-1",
      answers: { approach: "small", features: ["A", "b"], custom: "Typed answer" } }]);
  });

  it("answers an aliased long request id with T3's own id", async () => {
    const requestId = `runtime-request:provider:claudeAgent:${"x%253A".repeat(60)}`;
    const { createHash } = await import("node:crypto");
    const alias = `v2:${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`;
    const { commands, rpc } = commandRecorder();
    const baseUrl = await startUpstream(async (_request, response) => {
      respondJson(response, v2Detail({ id: "thread-1" }, { turnItems: [{ id: "turn-item:q", type: "user_input_request", requestId, runId: RUN_ID,
        questions: [{ id: "q", header: "Q", question: "Q?", options: [{ label: "A", description: "First" }] }] }] }));
    }, rpc);
    await new HttpT3Client(config(baseUrl)).respondToPlanInput({ threadId: "thread-1", requestId: alias, commandId: "even-plan-alias", answers: { q: "A" } });
    assert.equal(commands[0]!.requestId, requestId);
  });

  it("refuses to answer a request that is no longer in the thread", async () => {
    const { commands, rpc } = commandRecorder();
    const baseUrl = await startUpstream(async (_request, response) => {
      respondJson(response, v2Detail({ id: "thread-1" }));
    }, rpc);
    await assert.rejects(new HttpT3Client(config(baseUrl)).respondToPlanInput({
      threadId: "thread-1", requestId: "request-1", commandId: "even-plan-fixture", answers: { q: "A" },
    }), { code: "plan_request_unavailable" });
    assert.equal(commands.length, 0);
  });

  it("settles through the authenticated native command without changing runtime permissions", async () => {
    const { commands, rpc } = commandRecorder(() => ({ sequence: 75 }));
    const baseUrl = await startUpstream(notFound(), rpc);
    assert.deepEqual(await new HttpT3Client(config(baseUrl)).settleThread("thread-1"), { sequence: 75 });
    assert.match(String(commands[0]!.commandId), /^[0-9a-f-]{36}$/);
    assert.deepEqual(commands, [{ type: "thread.settle", commandId: commands[0]!.commandId, threadId: "thread-1" }]);
  });

  it("keeps native settlement failures private and does not retry a rejected mutation", async () => {
    const { commands, rpc } = commandRecorder(() => new RpcFailure("private pending approval details"));
    const baseUrl = await startUpstream(notFound(), rpc);
    await assert.rejects(new HttpT3Client(config(baseUrl)).settleThread("thread-1"),
      (error: unknown) => error instanceof ApiError && error.code === "upstream_operation_failed" &&
        !error.message.includes("private"));
    assert.equal(commands.length, 1);
  });

  it("steers a message into the active run through server-resolved delivery", async () => {
    const { commands, rpc } = commandRecorder(() => ({ sequence: 73 }));
    const baseUrl = await startUpstream(notFound(), rpc);
    const activeThread = {
      id: "thread-1",
      projectId: "project-1",
      title: "Active thread",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:01:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      session: {
        status: "running",
        activeTurnId: RUN_ID,
        updatedAt: "2026-09-04T10:01:00.000Z",
      },
    };

    const result = await new HttpT3Client(config(baseUrl)).steerMessage({
      thread: activeThread,
      text: "Use the smaller implementation",
    });

    assert.deepEqual(result, { sequence: 73 });
    assert.deepEqual(commands, [{
      type: "message.dispatch",
      commandId: commands[0]!.commandId,
      createdBy: "user",
      creationSource: "mobile",
      threadId: "thread-1",
      messageId: commands[0]!.messageId,
      text: "Use the smaller implementation",
      attachments: [],
      deliveryIntent: "steer",
      dispatchMode: { type: "start_immediately" },
    }]);
  });

  it("replies with automatic delivery", async () => {
    const { commands, rpc } = commandRecorder();
    const baseUrl = await startUpstream(notFound(), rpc);
    await new HttpT3Client(config(baseUrl)).replyMessage({ thread: {
      id: "thread-1", projectId: "project-1", title: "Thread", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required", interactionMode: "default", createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z", archivedAt: null, settledOverride: null, settledAt: null,
      latestTurn: null, session: null }, text: "Thanks" });
    assert.equal(commands[0]!.type, "message.dispatch");
    assert.equal(commands[0]!.deliveryIntent, "auto");
  });
});

describe("HttpT3Client model catalog", () => {
  it("returns only usable providers and normalizes model-specific reasoning", async () => {
    let wireRequest: Record<string, unknown> | undefined;
    const upstream = providerConfig();
    const providers = upstream.providers as Record<string, unknown>[];
    providers.push({
      instanceId: "claude-work",
      driver: "claudeAgent",
      displayName: "Claude Work",
      enabled: true,
      installed: true,
      status: "warning",
      auth: { status: "unknown" },
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
              { id: "fastMode", label: "Fast Mode", type: "boolean" },
            ],
          },
        },
      ],
    });
    const baseUrl = await startUpstream(notFound(), (request) => {
      wireRequest = request;
      return upstream;
    });

    const catalog = await new HttpT3Client(config(baseUrl)).modelCatalog();

    assert.deepEqual(wireRequest, {
      _tag: "Request",
      id: wireRequest!.id,
      tag: "server.getConfig",
      payload: {},
      headers: [],
    });
    assert.deepEqual(catalog, {
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
                  { id: "high", label: "High", isDefault: false },
                ],
              },
            },
          ],
        },
        {
          instanceId: "claude-work",
          label: "Claude Work",
          models: [
            {
              slug: "claude-sonnet-5",
              name: "Claude Sonnet 5",
              isDefault: false,
              reasoning: {
                id: "reasoning",
                t3OptionId: "effort",
                defaultChoiceId: "high",
                choices: [
                  { id: "low", label: "Low", isDefault: false },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes("private@example.com"), false);
    assert.equal(serialized.includes("must-not-escape"), false);
    assert.equal(serialized.includes("private provider detail"), false);
    assert.equal(serialized.includes(T3_ACCESS_TOKEN), false);
  });

  it("rejects malformed config responses without exposing their contents", async () => {
    const secret = "upstream-private-malformed-value";
    const baseUrl = await startUpstream(notFound(), () => ({
      providers: [
        {
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          secret,
        },
      ],
    }));

    await assert.rejects(
      new HttpT3Client(config(baseUrl)).modelCatalog(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_invalid_response");
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
  });

  it("times out a server that does not answer the RPC request", async () => {
    const baseUrl = await startUpstream(notFound(), null);

    await assert.rejects(
      new HttpT3Client(config(baseUrl, { upstreamTimeoutMs: 30 })).modelCatalog(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_timeout");
        assert.equal(error.message.includes(T3_ACCESS_TOKEN), false);
        return true;
      },
    );
  });

  it("rejects an oversized RPC response", async () => {
    const baseUrl = await startUpstream(notFound(), () => ({ providers: [], padding: "x".repeat(2048) }));

    await assert.rejects(
      new HttpT3Client(config(baseUrl, { maxUpstreamBytes: 512 })).modelCatalog(),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "upstream_invalid_response");
        return true;
      },
    );
  });
});

describe("HttpT3Client selected model validation", () => {
  it("uses Claude's real option id and explicitly disables fast mode", async () => {
    const upstream = providerConfig();
    upstream.providers = [
      {
        instanceId: "claude-work",
        driver: "claudeAgent",
        displayName: "Claude Work",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          {
            slug: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", isDefault: true },
                  ],
                },
                { id: "fastMode", type: "boolean" },
              ],
            },
          },
        ],
      },
    ];
    const { commands, rpc } = commandRecorder(undefined, () => upstream);
    const baseUrl = await startUpstream(notFound(), rpc);

    await new HttpT3Client(config(baseUrl)).startSession({
      project: project(null),
      threadId: "thread-claude",
      text: "Use Claude",
      runtimeMode: "approval-required",
      selection: {
        instanceId: "claude-work",
        model: "claude-sonnet-5",
        reasoningId: "low",
      },
    });

    assert.deepEqual(commands[0]!.modelSelection, {
      instanceId: "claude-work",
      model: "claude-sonnet-5",
      options: [
        { id: "effort", value: "low" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("rejects unadvertised model and reasoning selections before any write", async () => {
    const { commands, rpc } = commandRecorder();
    const baseUrl = await startUpstream(notFound(), rpc);
    const client = new HttpT3Client(config(baseUrl));

    for (const runtimeMode of ["approval-required", "full-access"] as const) {
      await assert.rejects(
        client.startSession({
          project: project(),
          threadId: "thread-bad-provider",
          text: "No write",
          runtimeMode,
          selection: { instanceId: "not-advertised", model: "gpt-5.6-sol" },
        }),
        (error: unknown) =>
          error instanceof ApiError && error.code === "provider_selection_unavailable",
      );
      await assert.rejects(
        client.startSession({
          project: project(),
          threadId: "thread-bad-model",
          text: "No write",
          runtimeMode,
          selection: { instanceId: "codex", model: "not-advertised" },
        }),
        (error: unknown) => error instanceof ApiError && error.code === "model_selection_unavailable",
      );
      await assert.rejects(
        client.startSession({
          project: project(),
          threadId: "thread-bad-reasoning",
          text: "No write",
          runtimeMode,
          selection: {
            instanceId: "codex",
            model: "gpt-5.6-sol",
            reasoningId: "ultra-secret-level",
          },
        }),
        (error: unknown) => error instanceof ApiError && error.code === "reasoning_selection_unavailable",
      );
    }
    assert.equal(commands.length, 0);
  });
});

describe("HttpT3Client V2 reads", () => {
  const v2Thread = { id: "thread-1", projectId: "assistant", title: "Archive", runtimeMode: "full-access",
    interactionMode: "default", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z", archivedAt: null,
    settledOverride: null, settledAt: null };

  it("reads the complete projection as a single archive page with the protocol header", async () => {
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${T3_ACCESS_TOKEN}`);
      assert.equal(request.url, "/api/orchestration/threads/thread-1");
      respondJson(response, v2Detail(v2Thread, {}, 5));
    });
    const result = await new HttpT3Client(config(baseUrl)).threadPage("thread-1");
    assert.deepEqual(result.page, { hasMore: false, beforeCursor: null, snapshotSequence: 5 });
    assert.equal(result.thread.id, "thread-1");
  });

  it("opens live views from the bounded recent window", async () => {
    const baseUrl = await startUpstream(async (request, response) => {
      assert.equal(request.url, "/api/orchestration/threads/thread-1/bounded");
      respondJson(response, { ...v2Detail(v2Thread, {}, 7), historyCursor: "opaque", hasMoreHistory: true,
        latestLocalTurnOrdinal: 3, payloadBudgetExceeded: true });
    });
    const result = await new HttpT3Client(config(baseUrl)).thread("thread-1");
    assert.equal(result.snapshotSequence, 7);
    assert.equal(result.thread.id, "thread-1");
  });

  it("refuses a continuation cursor rather than inventing older history", async () => {
    let requests = 0;
    const baseUrl = await startUpstream(async (_request, response) => { requests++; respondJson(response, v2Detail(v2Thread)); });
    await assert.rejects(() => new HttpT3Client(config(baseUrl)).threadPage("thread-1", "opaque"), /pagination is unavailable/);
    assert.equal(requests, 0);
  });

  it("rejects V1 snapshots as incompatible", async () => {
    const baseUrl = await startUpstream(async (request, response) => {
      respondJson(response, request.url === "/api/orchestration/shell"
        ? { snapshotSequence: 1, projects: [{ id: "p" }], threads: [{ id: "t" }], updatedAt: "2026-09-04T10:00:00.000Z" }
        : { snapshotSequence: 1, thread: { id: "thread-1", messages: [] } });
    });
    const client = new HttpT3Client(config(baseUrl));
    await assert.rejects(client.shell(), { code: "upstream_incompatible" });
    await assert.rejects(client.thread("thread-1"), { code: "upstream_incompatible" });
  });

  it("requires orchestration protocol 2 from the environment descriptor", async () => {
    for (const version of [undefined, 1, 2]) {
      const baseUrl = await startUpstream(async (_request, response) => {
        respondJson(response, { environmentId: "env", label: "Desk", serverVersion: "0.0.46", capabilities: {},
          ...(version === undefined ? {} : { orchestrationProtocolVersion: version }) });
      });
      const client = new HttpT3Client(config(baseUrl));
      if (version === 2) assert.equal((await client.descriptor()).environmentId, "env");
      else await assert.rejects(client.descriptor(), { code: "upstream_incompatible" });
    }
  });
});

describe("HttpT3Client session controls installed contract", () => {
  const thread = { id: "thread-1", projectId: "project-1", title: "Fixture", runtimeMode: "approval-required" as const,
    interactionMode: "default" as const, modelSelection: { instanceId: "codex", model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }, { id: "serviceTier", value: "fast" }, { id: "other", value: true }] },
    createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z", archivedAt: null,
    settledOverride: null, settledAt: null, latestTurn: null, session: null };

  it("persists selected mode before dispatching the draft", async () => {
    const { commands, rpc } = commandRecorder();
    const base = await startUpstream(notFound(), rpc);
    await new HttpT3Client(config(base)).sendMessage({ thread, text: "Plan the change", interactionMode: "plan" });
    assert.deepEqual(commands.map(c => c.type), ["thread.interaction-mode.set", "message.dispatch"]);
    assert.deepEqual(commands[0], { type: "thread.interaction-mode.set", commandId: commands[0]!.commandId,
      threadId: "thread-1", interactionMode: "plan" });
    assert.equal(commands[1]!.text, "Plan the change");
    assert.equal(commands[1]!.deliveryIntent, "auto");
    assert.equal("runtimeMode" in commands[1]!, false);
  });

  it("writes the reasoning selection before dispatching the message", async () => {
    let metadataUpdated = false;
    const selected = { ...thread.modelSelection, options: [
      { id: "serviceTier", value: "fast" }, { id: "other", value: true }, { id: "reasoningEffort", value: "high" }] };
    const { commands, rpc } = commandRecorder((command) => {
      if (command.type === "thread.model-selection.set") metadataUpdated = true;
      return undefined;
    });
    const base = await startUpstream(async (_request, response) => {
      respondJson(response, v2Detail({ ...thread, modelSelection: metadataUpdated ? selected : thread.modelSelection }));
    }, rpc);
    await new HttpT3Client(config(base)).sendMessage({ thread, text: "Use more reasoning", reasoningId: "high" });
    assert.deepEqual(commands.map(command => command.type), ["thread.model-selection.set", "message.dispatch"]);
    assert.deepEqual(commands[0]!.modelSelection, selected);
    assert.equal("modelSelection" in commands[1]!, false);
  });

  it("stops after rejected mode changes and does not retry failed dispatches", async () => {
    for (const failureIndex of [0, 1]) {
      const { commands, rpc } = commandRecorder((_command, index) => index === failureIndex ? new RpcFailure("private failure") : undefined);
      const base = await startUpstream(notFound(), rpc);
      await assert.rejects(new HttpT3Client(config(base)).sendMessage({ thread, text: "Reviewed draft", interactionMode: "plan" }), { code: "upstream_operation_failed" });
      assert.equal(commands.length, failureIndex + 1);
    }
  });

  it("validates reasoning against fresh catalog and preserves every unrelated model option", async () => {
    let catalogs = 0;
    const { commands, rpc } = commandRecorder(() => ({ sequence: 2 }), () => { catalogs++; return providerConfig(); });
    const base = await startUpstream(async (_request, response) => respondJson(response, v2Detail(thread)), rpc);
    const client = new HttpT3Client(config(base));
    await client.setReasoning({ thread, reasoningId: "high" });
    assert.deepEqual(commands[0], { type: "thread.model-selection.set", commandId: commands[0]!.commandId, threadId: "thread-1",
      modelSelection: { ...thread.modelSelection, options: [
        { id: "serviceTier", value: "fast" }, { id: "other", value: true }, { id: "reasoningEffort", value: "high" }] } });
    await assert.rejects(client.setReasoning({ thread, reasoningId: "invented" }), { code: "reasoning_selection_unavailable" });
    assert.equal(catalogs, 2); assert.equal(commands.length, 1);
  });

  it("changes the model with one selection write and no session restart", async () => {
    const { commands, rpc } = commandRecorder();
    const base = await startUpstream(async (_request, response) => respondJson(response, v2Detail(thread)), rpc);
    const result = await new HttpT3Client(config(base)).setModel({
      thread,
      selection: { instanceId: "codex", model: "gpt-5.6-sol", reasoningId: "high" },
    });
    assert.deepEqual(commands.map(command => command.type), ["thread.model-selection.set"]);
    assert.deepEqual(commands[0]!.modelSelection, { instanceId: "codex", model: "gpt-5.6-sol", options: [
      { id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }] });
    assert.equal(result.sequence, 1);
  });

  it("refuses a model or active-run change during reasoning catalog lookup", async () => {
    const run = { id: RUN_ID, threadId: "thread-1", ordinal: 1, status: "running", requestedAt: thread.updatedAt,
      startedAt: thread.updatedAt, completedAt: null };
    for (const changed of [v2Detail({ ...thread, modelSelection: { ...thread.modelSelection, model: "changed" } }),
      v2Detail(thread, { runs: [run] })]) {
      const { commands, rpc } = commandRecorder();
      const base = await startUpstream(async (_request, response) => respondJson(response, changed), rpc);
      await assert.rejects(new HttpT3Client(config(base)).setReasoning({ thread, reasoningId: "high" }));
      assert.equal(commands.length, 0);
    }
  });

  it("approves via the exact proposed-plan source reference and stable command IDs", async () => {
    const { commands, rpc } = commandRecorder();
    const base = await startUpstream(notFound(), rpc);
    await new HttpT3Client(config(base)).approvePlan({ thread: { ...thread, interactionMode: "plan" }, planId: "plan-1", planMarkdown: "Exact reviewed text", commandId: "even-implement-fixture" });
    assert.deepEqual(commands.map(c => c.type), ["thread.interaction-mode.set", "message.dispatch"]);
    assert.equal(commands[0]!.commandId, "even-implement-fixture-mode");
    assert.equal(commands[0]!.interactionMode, "default");
    assert.equal(commands[1]!.commandId, "even-implement-fixture");
    assert.equal(commands[1]!.messageId, "even-implement-fixture-message");
    assert.deepEqual(commands[1]!.sourcePlanRef, { threadId: thread.id, planId: "plan-1" });
    assert.equal(commands[1]!.text, "Implement this plan:\n\nExact reviewed text");
  });
});
