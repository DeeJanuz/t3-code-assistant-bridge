import { ApiError, isSafeId } from "./security.js";
import type {
  BridgeEnvironment,
  ResolvedT3Environment,
  T3Client,
  T3Descriptor,
  T3EnvironmentKind,
  T3EnvironmentRouter,
  T3EnvironmentSnapshot,
} from "./types.js";

interface Entry {
  environment: BridgeEnvironment;
  client: T3Client | null;
}

export interface EnvironmentRegistration {
  readonly descriptor: T3Descriptor;
  readonly kind: T3EnvironmentKind;
  readonly client: T3Client | null;
  readonly status?: BridgeEnvironment["status"];
  readonly errorCode?: string;
  readonly primary?: boolean;
}

function validLabel(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateDescriptor(descriptor: T3Descriptor): void {
  if (!isSafeId(descriptor.environmentId) || !validLabel(descriptor.label) ||
      typeof descriptor.serverVersion !== "string" || descriptor.serverVersion.length > 128 ||
      descriptor.capabilities.threadSettlement !== true) {
    throw new ApiError(502, "upstream_incompatible", "T3 Code is not compatible with this bridge");
  }
}

function unavailable(environmentId?: string): ApiError {
  return new ApiError(
    503,
    "upstream_unavailable",
    environmentId ? "The selected T3 environment is unavailable" : "T3 Code is unavailable",
  );
}

/** Mutable process-local registry. Credentials stay inside each registered client. */
export class ManagedEnvironmentRouter implements T3EnvironmentRouter {
  private readonly entries = new Map<string, Entry>();
  private primaryId: string | null = null;

  register(input: EnvironmentRegistration): BridgeEnvironment {
    validateDescriptor(input.descriptor);
    const environment: BridgeEnvironment = {
      environmentId: input.descriptor.environmentId,
      label: input.descriptor.label,
      kind: input.kind,
      status: input.status ?? (input.client ? "connected" : "offline"),
      isPrimary: input.primary === true,
      serverVersion: input.descriptor.serverVersion,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    };
    if (environment.status === "connected" && input.client === null) {
      throw new Error("A connected environment requires a client");
    }
    if (input.primary) {
      if (this.primaryId && this.primaryId !== environment.environmentId) {
        const previous = this.entries.get(this.primaryId);
        if (previous) previous.environment = { ...previous.environment, isPrimary: false };
      }
      this.primaryId = environment.environmentId;
    }
    this.entries.set(environment.environmentId, { environment, client: input.client });
    return environment;
  }

  replaceKind(kind: T3EnvironmentKind, registrations: readonly EnvironmentRegistration[]): void {
    const retained = new Set(registrations.map((item) => item.descriptor.environmentId));
    for (const [environmentId, entry] of this.entries) {
      if (entry.environment.kind === kind && !retained.has(environmentId) && !entry.environment.isPrimary) {
        this.entries.delete(environmentId);
      }
    }
    for (const registration of registrations) {
      const existing = this.entries.get(registration.descriptor.environmentId);
      if (existing?.environment.isPrimary && existing.environment.kind !== kind) continue;
      this.register(registration);
    }
  }

  markKindUnavailable(kind: T3EnvironmentKind, errorCode = "environment_unavailable"): void {
    for (const [environmentId, entry] of this.entries) {
      if (entry.environment.kind !== kind) continue;
      this.entries.set(environmentId, {
        client: null,
        environment: { ...entry.environment, status: "offline", errorCode },
      });
    }
  }

  removeEnvironment(environmentId: string, kind: T3EnvironmentKind): void {
    const entry = this.entries.get(environmentId);
    if (entry?.environment.kind === kind && !entry.environment.isPrimary) this.entries.delete(environmentId);
  }

  removePrimary(): void {
    if (!this.primaryId) return;
    this.entries.delete(this.primaryId);
    this.primaryId = null;
  }

  clear(): void {
    this.entries.clear();
    this.primaryId = null;
  }

  async list(): Promise<readonly BridgeEnvironment[]> {
    return [...this.entries.values()].map((entry) => entry.environment).sort((left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) || left.label.localeCompare(right.label) ||
      left.environmentId.localeCompare(right.environmentId));
  }

  async resolve(environmentId?: string): Promise<ResolvedT3Environment> {
    const id = environmentId ?? this.primaryId;
    if (!id) throw unavailable(environmentId);
    const entry = this.entries.get(id);
    if (!entry || !entry.client || entry.environment.status !== "connected") throw unavailable(id);
    return { environment: entry.environment, client: entry.client };
  }

  primary(): Promise<ResolvedT3Environment> {
    return this.resolve();
  }

  async snapshots(): Promise<{
    readonly available: readonly T3EnvironmentSnapshot[];
    readonly environments: readonly BridgeEnvironment[];
  }> {
    const entries = [...this.entries.entries()];
    const settled = await Promise.all(entries.map(async ([environmentId, entry]) => {
      if (!entry.client || entry.environment.status !== "connected") return null;
      try {
        const shell = await entry.client.shell();
        return { environment: entry.environment, client: entry.client, shell };
      } catch {
        this.entries.set(environmentId, {
          ...entry,
          environment: { ...entry.environment, status: "offline", errorCode: "environment_unavailable" },
        });
        return null;
      }
    }));
    return {
      available: settled.filter((value): value is T3EnvironmentSnapshot => value !== null),
      environments: await this.list(),
    };
  }
}

/** Compatibility adapter for tests and callers that still supply one T3 client. */
export class SingleEnvironmentRouter implements T3EnvironmentRouter {
  constructor(private readonly client: T3Client) {}
  private readonly environmentValue: BridgeEnvironment = {
    environmentId: "primary",
    label: "Primary environment",
    kind: "local",
    status: "connected",
    isPrimary: true,
  };
  async list() { return [this.environmentValue]; }
  async resolve(environmentId?: string) {
    const environment = this.environmentValue;
    if (environmentId !== undefined && environmentId !== environment.environmentId) throw unavailable(environmentId);
    return { environment, client: this.client };
  }
  primary() { return this.resolve(); }
  async snapshots() {
    const resolved = await this.resolve();
    return { available: [{ ...resolved, shell: await this.client.shell() }], environments: [resolved.environment] };
  }
}

export function isEnvironmentRouter(value: T3Client | T3EnvironmentRouter): value is T3EnvironmentRouter {
  return "resolve" in value && typeof value.resolve === "function" && "snapshots" in value;
}

export function asEnvironmentRouter(value: T3Client | T3EnvironmentRouter): T3EnvironmentRouter {
  return isEnvironmentRouter(value) ? value : new SingleEnvironmentRouter(value);
}

/** Restricts legacy helper services to the router's primary environment. */
export class PrimaryEnvironmentClient implements T3Client {
  constructor(private readonly router: T3EnvironmentRouter) {}
  private async client() { return (await this.router.primary()).client; }
  async descriptor() { return (await this.client()).descriptor(); }
  async shell() { return (await this.client()).shell(); }
  async thread(id: string) { return (await this.client()).thread(id); }
  async threadPage(id: string, cursor?: string) {
    const client = await this.client();
    if (!client.threadPage) throw new ApiError(502, "upstream_incompatible", "T3 Code pagination is unavailable");
    return client.threadPage(id, cursor);
  }
  async modelCatalog() { return (await this.client()).modelCatalog(); }
  async startSession(input: Parameters<T3Client["startSession"]>[0]) { return (await this.client()).startSession(input); }
  async sendMessage(input: Parameters<T3Client["sendMessage"]>[0]) { return (await this.client()).sendMessage(input); }
  async steerMessage(input: Parameters<T3Client["steerMessage"]>[0]) { return (await this.client()).steerMessage(input); }
  async replyMessage(input: Parameters<T3Client["replyMessage"]>[0]) { return (await this.client()).replyMessage(input); }
  async settleThread(id: string) { return (await this.client()).settleThread(id); }
  async respondToPlanInput(input: Parameters<T3Client["respondToPlanInput"]>[0]) { return (await this.client()).respondToPlanInput(input); }
  async setModel(input: Parameters<NonNullable<T3Client["setModel"]>>[0]) {
    const client = await this.client();
    if (!client.setModel) throw new ApiError(502, "upstream_incompatible", "Session model controls are unavailable");
    return client.setModel(input);
  }
  async setReasoning(input: Parameters<NonNullable<T3Client["setReasoning"]>>[0]) {
    const client = await this.client();
    if (!client.setReasoning) throw new ApiError(502, "upstream_incompatible", "Session reasoning controls are unavailable");
    return client.setReasoning(input);
  }
  async approvePlan(input: Parameters<NonNullable<T3Client["approvePlan"]>>[0]) {
    const client = await this.client();
    if (!client.approvePlan) throw new ApiError(502, "upstream_incompatible", "Plan approval is unavailable");
    return client.approvePlan(input);
  }
}
