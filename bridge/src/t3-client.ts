import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { ApiError } from "./security.js";
import { requireIdleSession } from "./session-controls.js";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  shellFromV2,
  threadFromV2,
  pendingUserInput,
  V2ShapeError,
} from "./t3-v2.js";
import type {
  BridgeConfig,
  T3CatalogModel,
  T3CatalogProvider,
  T3Client,
  T3Descriptor,
  T3ModelCatalog,
  T3ModelSelection,
  T3NewSessionSelection,
  T3Project,
  T3ProviderOptionSelection,
  T3ReasoningCatalog,
  T3ShellSnapshot,
  T3ThreadShell,
  T3ThreadSnapshot,
} from "./types.js";

export interface T3RequestAuthorization {
  requestUrl?(url: URL): Promise<URL>;
  headers(method: string, url: URL): Promise<Readonly<Record<string, string>>>;
  websocket(): Promise<{ readonly url: URL; readonly headers?: Readonly<Record<string, string>> }>;
  invalidate?(): void;
}

class BearerT3Authorization implements T3RequestAuthorization {
  constructor(private readonly baseUrl: URL, private readonly token: string) {}
  async headers() { return { Authorization: `Bearer ${this.token}` }; }
  async websocket() {
    const url = new URL("/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url, headers: { Authorization: `Bearer ${this.token}` } };
  }
}

class UpstreamError extends Error {}

async function readLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new UpstreamError("upstream response exceeded the configured limit");
  }
  if (response.body === null) throw new UpstreamError("upstream returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new UpstreamError("upstream response exceeded the configured limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UpstreamError("upstream returned invalid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDescriptorShape(value: unknown): value is T3Descriptor {
  return (
    isRecord(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.serverVersion === "string" &&
    isRecord(value.capabilities)
  );
}

/** Opaque command results; T3 returns the last committed event sequence. */
function dispatchResult(value: unknown): { readonly sequence: number } {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence)) {
    throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
  }
  return { sequence: value.sequence as number };
}

function v2(map: () => unknown): unknown {
  try { return map(); } catch (error) {
    if (error instanceof V2ShapeError) {
      throw new ApiError(502, "upstream_incompatible", "T3 Code is not compatible with this bridge");
    }
    throw error;
  }
}

/** V2 provenance. The glasses are a mobile client acting for the user. */
const CREATION_SOURCE = "mobile";

function titleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || "New session";
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}...`;
}

interface ParsedCatalogModel extends T3CatalogModel {
  readonly supportsStandardServiceTier: boolean;
  readonly supportsFastMode: boolean;
}

interface ParsedCatalogProvider extends T3CatalogProvider {
  readonly models: readonly ParsedCatalogModel[];
}

interface ParsedModelCatalog extends T3ModelCatalog {
  readonly providers: readonly ParsedCatalogProvider[];
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function reasoningCatalog(
  driver: string,
  capabilities: unknown,
): T3ReasoningCatalog | null {
  if (!isRecord(capabilities) || !Array.isArray(capabilities.optionDescriptors)) return null;
  const preferredId = driver === "claudeAgent" ? "effort" : "reasoningEffort";
  const descriptor = capabilities.optionDescriptors.find(
    (candidate) =>
      isRecord(candidate) && candidate.id === preferredId && candidate.type === "select",
  );
  if (!isRecord(descriptor) || !Array.isArray(descriptor.options)) return null;

  const choices = descriptor.options.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = requiredString(candidate, "id");
    const label = requiredString(candidate, "label");
    if (id === null || label === null) return [];
    return [{ id, label, isDefault: candidate.isDefault === true }];
  });
  if (choices.length === 0) return null;
  const currentValue = typeof descriptor.currentValue === "string" ? descriptor.currentValue : null;
  const defaultChoiceId =
    choices.find((choice) => choice.isDefault)?.id ??
    choices.find((choice) => choice.id === currentValue)?.id ??
    null;
  return {
    id: "reasoning",
    t3OptionId: preferredId,
    choices,
    defaultChoiceId,
  };
}

function hasOptionDescriptor(capabilities: unknown, id: string, type: string): boolean {
  return (
    isRecord(capabilities) &&
    Array.isArray(capabilities.optionDescriptors) &&
    capabilities.optionDescriptors.some(
      (candidate) => isRecord(candidate) && candidate.id === id && candidate.type === type,
    )
  );
}

function parseModelCatalog(value: unknown): ParsedModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
  }

  const providers: ParsedCatalogProvider[] = [];
  const seenProviders = new Set<string>();
  for (const candidate of value.providers) {
    if (!isRecord(candidate)) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    if (
      candidate.enabled !== true ||
      candidate.installed !== true ||
      candidate.availability === "unavailable" ||
      (candidate.status !== "ready" && candidate.status !== "warning")
    ) {
      continue;
    }
    if (!isRecord(candidate.auth) || candidate.auth.status === "unauthenticated") continue;
    const instanceId = requiredString(candidate, "instanceId");
    const driver = requiredString(candidate, "driver");
    if (instanceId === null || driver === null || !Array.isArray(candidate.models)) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    if (seenProviders.has(instanceId)) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    seenProviders.add(instanceId);

    const models: ParsedCatalogModel[] = [];
    const seenModels = new Set<string>();
    for (const modelCandidate of candidate.models) {
      if (!isRecord(modelCandidate)) {
        throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
      }
      const slug = requiredString(modelCandidate, "slug");
      const name = requiredString(modelCandidate, "name");
      if (slug === null || name === null || seenModels.has(slug)) {
        throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
      }
      seenModels.add(slug);
      const capabilities = modelCandidate.capabilities;
      models.push({
        slug,
        name,
        isDefault: modelCandidate.isDefault === true,
        reasoning: reasoningCatalog(driver, capabilities),
        supportsStandardServiceTier: hasOptionDescriptor(capabilities, "serviceTier", "select"),
        supportsFastMode: hasOptionDescriptor(capabilities, "fastMode", "boolean"),
      });
    }
    if (models.length > 0) {
      providers.push({
        instanceId,
        label: requiredString(candidate, "displayName") ?? instanceId,
        models,
      });
    }
  }
  return { providers };
}

function publicCatalog(catalog: ParsedModelCatalog): T3ModelCatalog {
  return {
    providers: catalog.providers.map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.label,
      models: provider.models.map(
        ({ supportsStandardServiceTier: _, supportsFastMode: __, ...model }) => model,
      ),
    })),
  };
}

function websocketDataBytes(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((size, part) => size + part.byteLength, 0);
  return data.byteLength;
}

function websocketDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
}

export class HttpT3Client implements T3Client {
  private modelCatalogCache: { value: ParsedModelCatalog; expiresAt: number } | null = null;
  private modelCatalogInFlight: Promise<ParsedModelCatalog> | null = null;
  private readonly authorization: T3RequestAuthorization;

  constructor(private readonly config: BridgeConfig, authorization?: T3RequestAuthorization) {
    if (!authorization && !config.t3AccessToken) throw new ApiError(503, "upstream_unavailable", "T3 Code is unavailable");
    this.authorization = authorization ?? new BearerT3Authorization(config.t3BaseUrl, config.t3AccessToken!);
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let url = new URL(path, this.config.t3BaseUrl);
    let response: Response;
    try {
      if (this.authorization.requestUrl) url = await this.authorization.requestUrl(url);
      const authorization = await this.authorization.headers(init?.method ?? "GET", url);
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...authorization,
          ...(url.pathname.startsWith("/api/orchestration/")
            ? { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION } : {}),
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init?.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
      });
    } catch {
      throw new ApiError(502, "upstream_unavailable", "T3 Code is unavailable");
    }
    const value = await readLimitedJson(response, this.config.maxUpstreamBytes).catch(() => {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.authorization.invalidate?.();
        throw new ApiError(502, "upstream_auth_failed", "T3 Code authorization failed");
      }
      throw new ApiError(502, "upstream_operation_failed", "T3 Code rejected the operation");
    }
    return value;
  }

  async descriptor(): Promise<T3Descriptor> {
    const value = await this.request("/.well-known/t3/environment");
    if (!hasDescriptorShape(value) ||
        String((value as unknown as Record<string, unknown>).orchestrationProtocolVersion) !== ORCHESTRATION_PROTOCOL_VERSION) {
      throw new ApiError(502, "upstream_incompatible", "T3 Code is not compatible with this bridge");
    }
    return value;
  }

  async shell(): Promise<T3ShellSnapshot> {
    const value = await this.request("/api/orchestration/shell");
    return v2(() => shellFromV2(value)) as T3ShellSnapshot;
  }

  /**
   * The recent window T3's own clients open with: every live control record
   * plus the latest runs. Long sessions exceed the upstream and peer limits as
   * full projections; the glasses only show recent turns.
   */
  async thread(threadId: string): Promise<T3ThreadSnapshot> {
    const value = await this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`);
    return v2(() => threadFromV2(value)) as T3ThreadSnapshot;
  }

  async threadPage(threadId: string, beforeCursor?: string): Promise<T3ThreadSnapshot> {
    // The archive needs the complete history; the full V2 projection is a single page.
    if (beforeCursor !== undefined) {
      throw new ApiError(502, "upstream_incompatible", "T3 Code pagination is unavailable");
    }
    const value = await this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
    const snapshot = v2(() => threadFromV2(value)) as T3ThreadSnapshot;
    return { ...snapshot, page: { hasMore: false, beforeCursor: null, snapshotSequence: snapshot.snapshotSequence } };
  }

  async modelCatalog(): Promise<T3ModelCatalog> {
    return publicCatalog(await this.readModelCatalog());
  }

  private async readModelCatalog(force = false): Promise<ParsedModelCatalog> {
    const now = Date.now();
    if (!force && this.modelCatalogCache && this.modelCatalogCache.expiresAt > now) return this.modelCatalogCache.value;
    if (this.modelCatalogInFlight) return this.modelCatalogInFlight;
    const request = this.fetchModelCatalog();
    this.modelCatalogInFlight = request;
    try {
      const value = await request;
      this.modelCatalogCache = { value, expiresAt: Date.now() + 30_000 };
      return value;
    } finally {
      if (this.modelCatalogInFlight === request) this.modelCatalogInFlight = null;
    }
  }

  private async fetchModelCatalog(): Promise<ParsedModelCatalog> {
    return parseModelCatalog(await this.rpc("server.getConfig", {}));
  }

  /** One request over T3's Effect RPC websocket, which carries every V2 command. */
  private async rpc(tag: string, payload: unknown): Promise<unknown> {
    const requestId = randomUUID();
    let connection: Awaited<ReturnType<T3RequestAuthorization["websocket"]>>;
    try {
      connection = await this.authorization.websocket();
    } catch {
      this.authorization.invalidate?.();
      throw new ApiError(502, "upstream_auth_failed", "T3 Code authorization failed");
    }
    const maximumBytes = this.config.maxUpstreamBytes;
    const timeoutMs = this.config.upstreamTimeoutMs;
    const url = new URL(connection.url);
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION);

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url, {
        ...(connection.headers ? { headers: connection.headers } : {}),
        followRedirects: false,
        handshakeTimeout: timeoutMs,
        maxPayload: maximumBytes,
        perMessageDeflate: false,
      });
      const finish = (result: { value: unknown } | { error: ApiError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.once("error", () => undefined);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        if ("error" in result) reject(result.error);
        else resolve(result.value);
      };
      const timer = setTimeout(() => {
        socket.terminate();
        finish({ error: new ApiError(502, "upstream_timeout", "T3 Code did not respond in time") });
      }, timeoutMs);
      timer.unref();

      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: requestId,
            tag,
            payload,
            headers: [],
          }),
          (error) => {
            if (error) {
              finish({ error: new ApiError(502, "upstream_unavailable", "T3 Code is unavailable") });
            }
          },
        );
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        const authFailure = response.statusCode === 401 || response.statusCode === 403;
        if (authFailure) this.authorization.invalidate?.();
        finish({
          error: authFailure
            ? new ApiError(502, "upstream_auth_failed", "T3 Code authorization failed")
            : new ApiError(502, "upstream_unavailable", "T3 Code is unavailable"),
        });
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary || websocketDataBytes(data) > maximumBytes) {
          finish({ error: new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response") });
          return;
        }
        let response: unknown;
        try {
          response = JSON.parse(websocketDataText(data));
        } catch {
          finish({ error: new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response") });
          return;
        }
        if (!isRecord(response) || response._tag !== "Exit" || response.requestId !== requestId) {
          finish({ error: new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response") });
          return;
        }
        if (!isRecord(response.exit) || response.exit._tag !== "Success" || !("value" in response.exit)) {
          finish({ error: new ApiError(502, "upstream_operation_failed", "T3 Code rejected the operation") });
          return;
        }
        finish({ value: response.exit.value });
      });
      socket.once("error", (error: Error & { code?: string }) => {
        finish({
          error:
            error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              ? new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response")
              : new ApiError(502, "upstream_unavailable", "T3 Code is unavailable"),
        });
      });
      socket.once("close", () => {
        finish({ error: new ApiError(502, "upstream_unavailable", "T3 Code is unavailable") });
      });
    });
  }

  async startSession(input: {
    readonly project: T3Project;
    readonly threadId: string;
    readonly text: string;
    readonly runtimeMode: BridgeConfig["runtimeMode"];
    readonly selection?: T3NewSessionSelection;
  }): Promise<{ readonly sequence: number }> {
    if (input.project.defaultModelSelection === null && input.selection === undefined) {
      throw new ApiError(
        409,
        "project_model_required",
        "Choose a default model for this project in T3 Code first",
      );
    }
    const requested = input.selection ?? {
      instanceId: input.project.defaultModelSelection!.instanceId,
      model: input.project.defaultModelSelection!.model,
    };
    const catalog = await this.readModelCatalog(true);
    const provider = catalog.providers.find((candidate) => candidate.instanceId === requested.instanceId);
    if (provider === undefined) {
      throw new ApiError(409, "provider_selection_unavailable", "The selected provider is not available in T3 Code");
    }
    const model = provider.models.find((candidate) => candidate.slug === requested.model);
    if (model === undefined) {
      throw new ApiError(409, "model_selection_unavailable", "The selected model is not available in T3 Code");
    }
    const options: T3ProviderOptionSelection[] = [];
    if (model.reasoning !== null) {
      const reasoningId = requested.reasoningId ?? model.reasoning.defaultChoiceId;
      if (reasoningId !== null) {
        if (!model.reasoning.choices.some((choice) => choice.id === reasoningId)) {
          throw new ApiError(409, "reasoning_selection_unavailable", "The selected reasoning level is not available for this model");
        }
        options.push({ id: model.reasoning.t3OptionId, value: reasoningId });
      }
    } else if (requested.reasoningId !== undefined) {
      throw new ApiError(409, "reasoning_selection_unavailable", "This model does not support reasoning levels");
    }
    if (model.supportsStandardServiceTier) options.push({ id: "serviceTier", value: "default" });
    if (model.supportsFastMode) options.push({ id: "fastMode", value: false });
    const modelSelection: T3ModelSelection = {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options.length > 0 ? { options } : {}),
    };

    await this.dispatch({
      type: "thread.create",
      commandId: randomUUID(),
      createdBy: "user",
      creationSource: CREATION_SOURCE,
      threadId: input.threadId,
      projectId: input.project.id,
      title: titleFromText(input.text),
      modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return this.dispatchMessage({ threadId: input.threadId, text: input.text, modelSelection,
      titleSeed: titleFromText(input.text), deliveryIntent: "auto" });
  }

  async sendMessage(input: {
    readonly thread: T3ThreadShell;
    readonly text: string;
    readonly interactionMode?: "default" | "plan";
    readonly reasoningId?: string;
  }): Promise<{ readonly sequence: number }> {
    if (input.reasoningId !== undefined) {
      await this.setReasoning({ thread: input.thread, reasoningId: input.reasoningId });
      const current = (await this.thread(input.thread.id)).thread;
      if (current.id !== input.thread.id || current.projectId !== input.thread.projectId || current.archivedAt !== null ||
          current.modelSelection.instanceId !== input.thread.modelSelection.instanceId ||
          current.modelSelection.model !== input.thread.modelSelection.model) {
        throw new ApiError(409, "model_selection_changed", "The session model changed. Refresh the session.");
      }
      requireIdleSession(current);
    }
    const mode = input.interactionMode ?? input.thread.interactionMode;
    if (mode !== input.thread.interactionMode) await this.setInteractionMode(input.thread.id, mode);
    return this.dispatchMessage({ threadId: input.thread.id, text: input.text, deliveryIntent: "auto" });
  }

  private async setInteractionMode(threadId: string, interactionMode: "default" | "plan", commandId: string = randomUUID()): Promise<{ readonly sequence: number }> {
    // T3 reads the persisted thread mode when a run starts.
    return this.dispatch({ type: "thread.interaction-mode.set", commandId, threadId, interactionMode });
  }

  /**
   * T3 V2 resolves delivery against its serialized thread state
   * (`serverResolvedCommandContext`): "auto" starts a run when idle and steers
   * or queues into an active run as the provider supports; "steer" asks for
   * same-run steering. The bridge validates once and never retries.
   */
  private async dispatchMessage(input: {
    readonly threadId: string;
    readonly text: string;
    readonly deliveryIntent: "auto" | "steer";
    readonly modelSelection?: T3ModelSelection;
    readonly titleSeed?: string;
    readonly sourcePlanRef?: { readonly threadId: string; readonly planId: string };
    readonly commandId?: string;
  }): Promise<{ readonly sequence: number }> {
    const commandId = input.commandId ?? randomUUID();
    return this.dispatch({
      type: "message.dispatch",
      commandId,
      createdBy: "user",
      creationSource: CREATION_SOURCE,
      threadId: input.threadId,
      messageId: input.commandId === undefined ? randomUUID() : `${commandId}-message`,
      text: input.text,
      attachments: [],
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      ...(input.titleSeed === undefined ? {} : { titleSeed: input.titleSeed }),
      ...(input.sourcePlanRef === undefined ? {} : { sourcePlanRef: input.sourcePlanRef }),
      deliveryIntent: input.deliveryIntent,
      dispatchMode: { type: "start_immediately" },
    });
  }

  async setReasoning(input: { readonly thread: T3ThreadShell; readonly reasoningId: string }): Promise<{ readonly sequence: number }> {
    const selection = input.thread.modelSelection;
    const catalog = await this.readModelCatalog(true);
    const model = catalog.providers.find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model);
    const reasoning = model?.reasoning;
    if (!reasoning || !reasoning.choices.some((choice) => choice.id === input.reasoningId)) {
      throw new ApiError(409, "reasoning_selection_unavailable", "The selected reasoning level is not available for this model");
    }
    // Catalog lookup may take time. Re-read before the metadata write so a
    // changed model, active turn, or updated unrelated option is not overwritten.
    const current = (await this.thread(input.thread.id)).thread;
    if (current.id !== input.thread.id || current.projectId !== input.thread.projectId || current.archivedAt !== null ||
        current.modelSelection.instanceId !== selection.instanceId || current.modelSelection.model !== selection.model) {
      throw new ApiError(409, "model_selection_changed", "The session model changed. Refresh the session.");
    }
    requireIdleSession(current);
    // Preserve provider, model, speed and every unrelated existing option.
    const options = [...(current.modelSelection.options ?? []).filter((option) => option.id !== reasoning.t3OptionId),
      { id: reasoning.t3OptionId, value: input.reasoningId }];
    // V2 applies the thread selection when the next run starts, including a
    // provider switch with its context handoff, so no session restart is needed.
    return this.dispatch({ type: "thread.model-selection.set", commandId: randomUUID(), threadId: input.thread.id,
      modelSelection: { ...current.modelSelection, options } });
  }

  async setModel(input: { readonly thread: T3ThreadShell; readonly selection: T3NewSessionSelection }): Promise<{ readonly sequence: number }> {
    const catalog = await this.readModelCatalog(true);
    const provider = catalog.providers.find((candidate) => candidate.instanceId === input.selection.instanceId);
    const model = provider?.models.find((candidate) => candidate.slug === input.selection.model);
    if (!provider) throw new ApiError(409, "provider_selection_unavailable", "The selected provider is not available in T3 Code");
    if (!model) throw new ApiError(409, "model_selection_unavailable", "The selected model is not available in T3 Code");
    const options: T3ProviderOptionSelection[] = [];
    if (model.reasoning !== null) {
      const reasoningId = input.selection.reasoningId ?? model.reasoning.defaultChoiceId;
      if (reasoningId !== null) {
        if (!model.reasoning.choices.some((choice) => choice.id === reasoningId)) {
          throw new ApiError(409, "reasoning_selection_unavailable", "The selected reasoning level is not available for this model");
        }
        options.push({ id: model.reasoning.t3OptionId, value: reasoningId });
      }
    } else if (input.selection.reasoningId !== undefined) {
      throw new ApiError(409, "reasoning_selection_unavailable", "This model does not support reasoning levels");
    }
    if (model.supportsStandardServiceTier) options.push({ id: "serviceTier", value: "default" });
    if (model.supportsFastMode) options.push({ id: "fastMode", value: false });
    const current = (await this.thread(input.thread.id)).thread;
    if (current.id !== input.thread.id || current.projectId !== input.thread.projectId || current.archivedAt !== null ||
        current.modelSelection.instanceId !== input.thread.modelSelection.instanceId || current.modelSelection.model !== input.thread.modelSelection.model) {
      throw new ApiError(409, "model_selection_changed", "The session model changed. Refresh the session.");
    }
    requireIdleSession(current);
    return this.dispatch({ type: "thread.model-selection.set", commandId: randomUUID(), threadId: current.id,
      modelSelection: { instanceId: provider.instanceId, model: model.slug, ...(options.length > 0 ? { options } : {}) } });
  }

  async approvePlan(input: { readonly thread: T3ThreadShell; readonly planId: string; readonly planMarkdown: string; readonly commandId: string }): Promise<{ readonly sequence: number }> {
    await this.setInteractionMode(input.thread.id, "default", `${input.commandId}-mode`);
    return this.dispatchMessage({ threadId: input.thread.id, commandId: input.commandId, deliveryIntent: "auto",
      text: `Implement this plan:\n\n${input.planMarkdown}`,
      sourcePlanRef: { threadId: input.thread.id, planId: input.planId } });
  }

  async steerMessage(input: {
    readonly thread: T3ThreadShell;
    readonly text: string;
  }): Promise<{ readonly sequence: number }> {
    return this.dispatchMessage({ threadId: input.thread.id, text: input.text, deliveryIntent: "steer" });
  }

  async replyMessage(input: {
    readonly thread: T3ThreadShell;
    readonly text: string;
  }): Promise<{ readonly sequence: number }> {
    return this.dispatchMessage({ threadId: input.thread.id, text: input.text, deliveryIntent: "auto" });
  }

  async settleThread(threadId: string): Promise<{ readonly sequence: number }> {
    // T3 enforces running/queued-run and blocking-request checks atomically.
    // Do not replace this command with a metadata write or auto-settlement.
    return this.dispatch({ type: "thread.settle", commandId: randomUUID(), threadId });
  }

  async respondToPlanInput(input: {
    readonly threadId: string;
    readonly requestId: string;
    readonly commandId: string;
    readonly answers: Readonly<Record<string, string | string[]>>;
  }): Promise<{ readonly sequence: number }> {
    // Glasses answer with option labels. T3 expects each option's value,
    // which defaults to its label.
    const pending = pendingUserInput(
      await this.request(`/api/orchestration/threads/${encodeURIComponent(input.threadId)}/bounded`), input.requestId);
    if (pending === null) throw new ApiError(409, "plan_request_unavailable", "These questions are no longer available. Refresh the session.");
    const values = pending.optionValues;
    const answers = Object.fromEntries(Object.entries(input.answers).map(([questionId, answer]) => {
      const options = values.get(questionId);
      const value = (label: string) => options?.get(label) ?? label;
      return [questionId, Array.isArray(answer) ? answer.map(value) : value(answer)];
    }));
    return this.dispatch({
      type: "runtime-request.respond",
      commandId: input.commandId,
      threadId: input.threadId,
      requestId: pending.requestId,
      answers,
    });
  }

  private async dispatch(command: Record<string, unknown>): Promise<{ readonly sequence: number }> {
    return dispatchResult(await this.rpc("orchestration.dispatchCommand", command));
  }
}
