import type { Server } from 'node:http';
import { ApiError } from './security.js';
import { createBridgeServer } from './server.js';
import { HttpT3Client } from './t3-client.js';
import { ManagedEnvironmentRouter } from './environment-router.js';
import { WhisperCppTranscriber } from './voice.js';
import type { BridgeConfig, T3Client, T3Descriptor, Transcriber } from './types.js';

/** Fixed provider origin and authenticated readiness; no placeholder token or mutable remote URL. */
export class RecoveringT3Client implements T3Client {
  private current: T3Client | null = null;
  private generation = 0;
  constructor(private readonly config: BridgeConfig,
    private readonly factory: (config: BridgeConfig) => T3Client = config => new HttpT3Client(config)) {}
  async useToken(token: string): Promise<T3Descriptor> {
    if (!token || token.length > 16_384 || /[\u0000-\u0020\u007f]/.test(token)) {
      throw new ApiError(503, 'upstream_auth_failed', 'T3 Code authorization failed');
    }
    const generation = ++this.generation;
    const candidate = this.factory({ ...this.config, t3AccessToken: token });
    const descriptor = await candidate.descriptor();
    if (descriptor.capabilities.threadSettlement !== true) {
      throw new ApiError(502, 'upstream_incompatible', 'T3 Code does not support session settlement');
    }
    if (generation === this.generation) this.current = candidate;
    return descriptor;
  }
  clear(): void { this.generation++; this.current = null; }
  private ready(): T3Client {
    if (!this.current) throw new ApiError(503, 'upstream_unavailable', 'T3 Code is unavailable');
    return this.current;
  }
  async descriptor() { return this.ready().descriptor(); }
  async shell() { return this.ready().shell(); }
  async thread(id: string) { return this.ready().thread(id); }
  async threadPage(id: string, cursor?: string) {
    const client = this.ready();
    if (!client.threadPage) throw new ApiError(502, 'upstream_incompatible', 'T3 Code does not support transcript pagination');
    return client.threadPage(id, cursor);
  }
  async modelCatalog() { return this.ready().modelCatalog(); }
  async setModel(input: Parameters<NonNullable<T3Client['setModel']>>[0]) {
    const client = this.ready();
    if (!client.setModel) throw new ApiError(502, 'upstream_incompatible', 'Session model controls are unavailable');
    return client.setModel(input);
  }
  async setReasoning(input: Parameters<NonNullable<T3Client['setReasoning']>>[0]) {
    const client = this.ready();
    if (!client.setReasoning) throw new ApiError(502, 'upstream_incompatible', 'Session reasoning controls are unavailable');
    return client.setReasoning(input);
  }
  async approvePlan(input: Parameters<NonNullable<T3Client['approvePlan']>>[0]) {
    const client = this.ready();
    if (!client.approvePlan) throw new ApiError(502, 'upstream_incompatible', 'Plan approval is unavailable');
    return client.approvePlan(input);
  }
  async startSession(input: Parameters<T3Client['startSession']>[0]) { return this.ready().startSession(input); }
  async sendMessage(input: Parameters<T3Client['sendMessage']>[0]) { return this.ready().sendMessage(input); }
  async steerMessage(input: Parameters<T3Client['steerMessage']>[0]) { return this.ready().steerMessage(input); }
  async replyMessage(input: Parameters<T3Client['replyMessage']>[0]) { return this.ready().replyMessage(input); }
  async settleThread(id: string) { return this.ready().settleThread(id); }
  async respondToPlanInput(input: Parameters<T3Client['respondToPlanInput']>[0]) { return this.ready().respondToPlanInput(input); }
}

export class RecoveringTranscriber implements Transcriber {
  private current: Transcriber | null = null;
  set(value: Transcriber | null): void { this.current = value; }
  async transcribe(pcm: readonly Buffer[], signal: AbortSignal): Promise<string> {
    if (!this.current) throw new ApiError(503, 'transcription_unavailable', 'Dictation is temporarily unavailable');
    return this.current.transcribe(pcm, signal);
  }
}

export interface BridgeRuntime {
  server: Server;
  useT3Token(token: string): Promise<T3Descriptor>;
  clearT3(): void;
  useWhisper(url: URL | null): void;
}

/** Starts HTTP and native phone support immediately; providers are attached separately. */
export function startBridgeRuntime(config: BridgeConfig): BridgeRuntime {
  const tokens = new Set<string>();
  const runtimeConfig: BridgeConfig = { ...config, additionalRedactionSecrets: () => [
    ...(config.additionalRedactionSecrets?.() ?? []), ...tokens,
  ] };
  const client = new RecoveringT3Client(runtimeConfig);
  const environments = new ManagedEnvironmentRouter();
  const transcriber = new RecoveringTranscriber();
  const server = createBridgeServer(runtimeConfig, environments, transcriber);
  server.listen(config.port, config.host, () => process.stdout.write(`${JSON.stringify({
    level: 'info', message: 'Even bridge listening', host: config.host, port: config.port,
    at: new Date().toISOString(),
  })}\n`));
  return {
    server,
    useT3Token: async token => {
      tokens.add(token);
      const descriptor = await client.useToken(token);
      environments.register({ descriptor, kind: 'local', client, primary: true });
      return descriptor;
    },
    clearT3: () => { client.clear(); environments.removePrimary(); },
    useWhisper: url => {
      if (url !== null && (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/inference'))) {
        throw new Error('Whisper must use a numeric loopback inference endpoint');
      }
      transcriber.set(url === null ? null : new WhisperCppTranscriber({ ...config, whisperServerUrl: url }));
    },
  };
}
