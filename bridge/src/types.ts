import type { IncomingMessage } from "node:http";

export type RuntimeMode =
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access";

export interface BridgeConfig {
  readonly peerDirectory?: string;
  readonly signal?: { readonly cliPath: string; readonly dataDirectory: string };
  readonly faceclawProjectId?: string;
  readonly refinementCodexPath?: string;
  readonly archive?: { readonly projectId: string; readonly workspaceRoot: string } | null;
  readonly host: string;
  readonly port: number;
  readonly bridgeToken: string;
  readonly bridgePassphrase: string | null;
  readonly projectIds: ReadonlySet<string> | null;
  readonly runtimeMode: RuntimeMode;
  readonly pollIntervalMs: number;
  readonly rateLimitPerMinute: number;
  readonly maxBodyBytes: number;
  readonly maxTextChars: number;
  readonly maxUpstreamBytes: number;
  readonly upstreamTimeoutMs: number;
  readonly t3BaseUrl: URL;
  readonly t3AccessToken: string | null;
  readonly additionalRedactionSecrets?: () => readonly string[];
  readonly whisperServerUrl: URL;
  readonly whisperLanguage: string;
  readonly whisperPartialIntervalMs: number;
  readonly transcriptionTimeoutMs: number;
  readonly maxVoiceBytes: number;
}

export interface T3ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly T3ProviderOptionSelection[];
}

export interface T3ProviderOptionSelection {
  readonly id: string;
  readonly value: string | boolean;
}

export interface T3ReasoningChoice {
  /** Provider-neutral choice id used by bridge clients, such as `low` or `high`. */
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface T3ReasoningCatalog {
  /** Stable bridge-facing identifier. */
  readonly id: "reasoning";
  /** Exact option id T3 expects for this provider and model. */
  readonly t3OptionId: "reasoningEffort" | "effort";
  readonly choices: readonly T3ReasoningChoice[];
  readonly defaultChoiceId: string | null;
}

export interface T3CatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly reasoning: T3ReasoningCatalog | null;
}

export interface T3CatalogProvider {
  readonly instanceId: string;
  readonly label: string;
  readonly models: readonly T3CatalogModel[];
}

export interface T3ModelCatalog {
  readonly providers: readonly T3CatalogProvider[];
}

export interface T3NewSessionSelection {
  readonly instanceId: string;
  readonly model: string;
  /** Provider-neutral choice id advertised in the fresh model catalog. */
  readonly reasoningId?: string;
}

export interface T3Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection: T3ModelSelection | null;
  readonly deletedAt?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface T3LatestTurn {
  readonly turnId: string;
  readonly state: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Untrusted upstream identifier. Normalize and validate before using it. */
  readonly assistantMessageId?: unknown;
}

export interface T3SessionState {
  readonly status: string;
  readonly activeTurnId?: string | null;
  readonly updatedAt: string;
}

export interface T3ThreadShell {
  readonly hasPendingUserInput?: boolean;
  /**
   * In-memory T3 state for work that outlives the turn: "working" while
   * subagents or workflows run, "monitoring" when only watch loops remain.
   * Untrusted; read it through `sessionBackground`.
   */
  readonly backgroundLiveness?: unknown;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: T3ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default" | "plan";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt?: string | null;
  /** T3 runs each subagent in a child thread; its sidebar nests these under the parent. */
  readonly subagent?: boolean;
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn: T3LatestTurn | null;
  readonly session: T3SessionState | null;
}

export interface T3Message {
  readonly attachments?: readonly unknown[];
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Activity metadata read from the untrusted T3 response. Payload fields stay opaque. */
export interface T3ThreadActivity {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly turnId?: unknown;
  readonly createdAt?: unknown;
  readonly summary?: unknown;
  readonly payload?: unknown;
}

export interface T3LiveActivity {
  readonly phase: "thinking" | "tool";
  readonly label: string;
  readonly updatedAt: string;
}

export interface T3LiveToolActivity {
  readonly id: string;
  readonly kind: "tool";
  /** One-line bridge-owned preview, sanitized and capped at 120 characters. */
  readonly label: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface T3Thread extends T3ThreadShell {
  readonly messages: readonly T3Message[];
  readonly activities?: readonly T3ThreadActivity[];
  /** Structured proposed plans are untrusted upstream data. */
  readonly proposedPlans?: readonly unknown[];
}

export interface T3ShellSnapshot {
  readonly snapshotSequence: number;
  readonly projects: readonly T3Project[];
  readonly threads: readonly T3ThreadShell[];
  readonly updatedAt: string;
}

export interface T3ThreadSnapshot {
  readonly snapshotSequence: number;
  readonly thread: T3Thread;
  readonly page?: { readonly hasMore: boolean; readonly beforeCursor: string | null; readonly snapshotSequence: number; readonly threadSequence?: number };
}

export interface T3Descriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly capabilities: Record<string, unknown>;
}

export type T3EnvironmentKind = "local" | "peer" | "t3-connect" | "bearer" | "ssh" | "wsl";
export type T3EnvironmentStatus = "connected" | "connecting" | "offline" | "error";

/** Public, secret-free environment state exposed by the bridge. */
export interface BridgeEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly kind: T3EnvironmentKind;
  readonly status: T3EnvironmentStatus;
  readonly isPrimary: boolean;
  readonly serverVersion?: string;
  readonly errorCode?: string;
}

export interface ResolvedT3Environment {
  readonly environment: BridgeEnvironment;
  readonly client: T3Client;
}

export interface T3EnvironmentSnapshot extends ResolvedT3Environment {
  readonly shell: T3ShellSnapshot;
}

export interface T3EnvironmentRouter {
  list(): Promise<readonly BridgeEnvironment[]>;
  resolve(environmentId?: string): Promise<ResolvedT3Environment>;
  primary(): Promise<ResolvedT3Environment>;
  snapshots(): Promise<{
    readonly available: readonly T3EnvironmentSnapshot[];
    readonly environments: readonly BridgeEnvironment[];
  }>;
}

export interface T3Client {
  setModel?(input: { readonly thread: T3ThreadShell; readonly selection: T3NewSessionSelection }): Promise<{ readonly sequence: number }>;
  setReasoning?(input: { readonly thread: T3ThreadShell; readonly reasoningId: string }): Promise<{ readonly sequence: number }>;
  approvePlan?(input: { readonly thread: T3ThreadShell; readonly planId: string; readonly planMarkdown: string; readonly commandId: string }): Promise<{ readonly sequence: number }>;
  settleThread(threadId: string): Promise<{ readonly sequence: number }>;
  respondToPlanInput(input: {
    readonly threadId: string;
    readonly requestId: string;
    readonly commandId: string;
    readonly answers: Readonly<Record<string, string | string[]>>;
  }): Promise<{ readonly sequence: number }>;
  descriptor(): Promise<T3Descriptor>;
  shell(): Promise<T3ShellSnapshot>;
  thread(threadId: string): Promise<T3ThreadSnapshot>;
  threadPage?(threadId: string, beforeCursor?: string): Promise<T3ThreadSnapshot>;
  modelCatalog(): Promise<T3ModelCatalog>;
  startSession(input: {
    readonly project: T3Project;
    readonly threadId: string;
    readonly text: string;
    readonly runtimeMode: RuntimeMode;
    readonly selection?: T3NewSessionSelection;
  }): Promise<{ readonly sequence: number }>;
  sendMessage(input: {
    readonly thread: T3ThreadShell;
    readonly text: string;
    readonly interactionMode?: "default" | "plan";
    readonly reasoningId?: string;
  }): Promise<{ readonly sequence: number }>;
  steerMessage(input: {
    readonly thread: T3ThreadShell;
    readonly text: string;
  }): Promise<{ readonly sequence: number }>;
  replyMessage(input: {
    readonly thread: T3ThreadShell;
    readonly text: string;
  }): Promise<{ readonly sequence: number }>;
}

export interface Transcriber {
  transcribe(pcm: readonly Buffer[], signal: AbortSignal): Promise<string>;
}

export interface AuthorizedRequest extends IncomingMessage {
  requestId?: string;
}
