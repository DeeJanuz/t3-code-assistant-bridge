import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError, isSafeId } from "./security.js";
import { HttpT3Client, type T3RequestAuthorization } from "./t3-client.js";
import type { BridgeConfig, T3Descriptor } from "./types.js";
import type { EnvironmentRegistration } from "./environment-router.js";

const MAX_SECRET_BYTES = 64 * 1024;
const DEFAULT_RELAY_URL = "https://relay.t3.codes";
const DEFAULT_TOKEN_ENDPOINT = "https://clerk.t3.codes/oauth/token";
const DEFAULT_OAUTH_CLIENT_ID = "hzxSgY2cH10sDU2r";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const RELAY_SCOPES = "environment:connect environment:status";
const ENVIRONMENT_SCOPES = "orchestration:read orchestration:operate";
const REFRESH_EARLY_MS = 5 * 60_000;

interface PersistedCloudToken {
  accessToken: string;
  refreshToken: string;
  expiresAtEpochMs: number;
  identity?: string;
}

interface RelayEndpoint {
  httpBaseUrl: string;
  wsBaseUrl: string;
  providerKind: string;
}

interface RelayEnvironment {
  environmentId: string;
  label: string;
  endpoint: RelayEndpoint;
  linkedAt: string;
}

interface EnvironmentSession {
  accessToken: string;
  expiresAt: number;
  httpBaseUrl: URL;
  wsBaseUrl: URL;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function tokenText(value: unknown, maximum = 32_768): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u0020\u007f]/u.test(value);
}

function labelText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function secureOrigin(value: unknown, protocol: "https:" | "wss:"): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid T3 Connect endpoint");
  const url = new URL(value);
  const validPath = url.pathname === "/" || url.pathname === "" ||
    (protocol === "wss:" && url.pathname === "/ws");
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash || !validPath) {
    throw new Error("Invalid T3 Connect endpoint");
  }
  return url;
}

function secureHttpsUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid secure URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid secure URL");
  }
  return url;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SECRET_BYTES) throw new Error("Response too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SECRET_BYTES) throw new Error("Response too large");
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJson(url: URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ApiError(502, "upstream_unavailable", "T3 Connect is unavailable");
  }
  let value: unknown = null;
  try { value = await readLimitedJson(response); }
  catch {
    if (response.ok) throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned an invalid response");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, "upstream_auth_failed", "T3 Connect authorization failed");
    }
    throw new ApiError(502, "upstream_operation_failed", "T3 Connect rejected the operation");
  }
  return value;
}

async function readOwnerFile(path: string, optional = false): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && record(error)?.code === "ENOENT") return null;
    throw new Error("Could not read T3 Connect credentials");
  }
  try {
    const metadata = await handle.stat();
    const uid = process.getuid?.();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SECRET_BYTES ||
        (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0) {
      throw new Error("T3 Connect credential permissions are unsafe");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

class CredentialChangedError extends Error {}

async function writeOwnerFile(path: string, value: string, expected: string): Promise<void> {
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error("T3 Connect credential is too large");
  const directory = await realpath(dirname(path));
  const temporary = join(directory, `.even-t3-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Do not replace a credential T3 refreshed while this process was making
    // its own token request. The caller retries from the newer value.
    if (await readOwnerFile(path) !== expected) throw new CredentialChangedError("T3 Connect credential changed");
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

class DpopSigner {
  private readonly privateKey;
  readonly publicJwk: { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };
  readonly thumbprint: string;

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("Could not create DPoP key");
    this.publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
    this.thumbprint = createHash("sha256").update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y })).digest("base64url");
  }

  proof(method: string, inputUrl: URL, accessToken?: string): string {
    const url = new URL(inputUrl);
    url.search = "";
    url.hash = "";
    const header = Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      htm: method.toUpperCase(),
      htu: url.toString(),
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      ...(accessToken ? { ath: createHash("sha256").update(accessToken).digest("base64url") } : {}),
    })).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: this.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }
}

class RemoteEnvironmentAuthorization implements T3RequestAuthorization {
  private session: EnvironmentSession | null = null;
  private pending: Promise<EnvironmentSession> | null = null;
  constructor(private readonly manager: T3ConnectManager, private readonly environment: RelayEnvironment) {}

  private async current(): Promise<EnvironmentSession> {
    if (this.session && this.session.expiresAt > Date.now() + 5_000) return this.session;
    this.pending ??= this.manager.createEnvironmentSession(this.environment);
    try { return this.session = await this.pending; }
    finally { this.pending = null; }
  }

  async headers(method: string, url: URL): Promise<Readonly<Record<string, string>>> {
    const session = await this.current();
    return { Authorization: `DPoP ${session.accessToken}`, DPoP: this.manager.proof(method, url, session.accessToken) };
  }

  async requestUrl(input: URL): Promise<URL> {
    const session = await this.current();
    const url = new URL(session.httpBaseUrl);
    url.pathname = input.pathname;
    url.search = input.search;
    return url;
  }

  invalidate(): void { this.session = null; }

  async websocket(): Promise<{ readonly url: URL }> {
    const session = await this.current();
    const ticketUrl = new URL("/api/auth/websocket-ticket", session.httpBaseUrl);
    const result = record(await fetchJson(ticketUrl, {
      method: "POST",
      headers: await this.headers("POST", ticketUrl),
    }));
    if (!result || !tokenText(result.ticket, 8192)) throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    const url = new URL(session.wsBaseUrl);
    if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
    url.searchParams.set("wsTicket", result.ticket);
    url.searchParams.set("clientLabel", "Faceclaw T3 Bridge");
    url.searchParams.set("clientDeviceType", "unknown");
    url.searchParams.set("clientOs", process.platform);
    url.searchParams.set("connectionMethod", "relay");
    return { url };
  }
}

/** Discovers every account-linked T3 Connect environment using T3's owner-only CLI credential. */
export class T3ConnectManager {
  private readonly signer = new DpopSigner();
  private readonly authorizations = new Map<string, {
    readonly endpointKey: string;
    readonly authorization: RemoteEnvironmentAuthorization;
  }>();
  private cloudTokenPending: Promise<PersistedCloudToken | null> | null = null;
  private relayToken: { accessToken: string; expiresAt: number; relayOrigin: string } | null = null;
  private relayTokenPending: { relayOrigin: string; promise: Promise<{
    accessToken: string;
    expiresAt: number;
    relayOrigin: string;
  }> } | null = null;
  private readonly secretsDirectory: string;
  private readonly tokenEndpoint: URL;
  private readonly oauthClientId: string;
  private readonly relayUrlOverride: string | null;

  constructor(private readonly config: BridgeConfig, baseDirectory: string, env: NodeJS.ProcessEnv = process.env) {
    this.secretsDirectory = join(baseDirectory, "userdata", "secrets");
    this.tokenEndpoint = secureHttpsUrl(env.T3_CONNECT_TOKEN_ENDPOINT ?? DEFAULT_TOKEN_ENDPOINT);
    this.oauthClientId = env.T3_CONNECT_OAUTH_CLIENT_ID?.trim() || DEFAULT_OAUTH_CLIENT_ID;
    this.relayUrlOverride = env.T3CODE_RELAY_URL?.trim() || null;
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(this.oauthClientId)) throw new Error("Invalid T3 Connect OAuth client ID");
  }

  proof(method: string, url: URL, accessToken?: string): string {
    return this.signer.proof(method, url, accessToken);
  }

  private async cloudToken(): Promise<PersistedCloudToken | null> {
    this.cloudTokenPending ??= this.readOrRefreshCloudToken();
    try { return await this.cloudTokenPending; }
    finally { this.cloudTokenPending = null; }
  }

  private async readOrRefreshCloudToken(retryOnChange = true): Promise<PersistedCloudToken | null> {
    const path = join(this.secretsDirectory, "cloud-cli-oauth-token.bin");
    const raw = await readOwnerFile(path, true);
    if (raw === null) return null;
    const value = record(JSON.parse(raw));
    if (!value || !tokenText(value.accessToken) || !tokenText(value.refreshToken) ||
        typeof value.expiresAtEpochMs !== "number" || !Number.isFinite(value.expiresAtEpochMs) ||
        !(value.identity === undefined || (typeof value.identity === "string" && value.identity.length <= 512))) {
      throw new Error("T3 Connect credential is invalid");
    }
    const token: PersistedCloudToken = { accessToken: value.accessToken, refreshToken: value.refreshToken,
      expiresAtEpochMs: value.expiresAtEpochMs, ...(typeof value.identity === "string" ? { identity: value.identity } : {}) };
    if (token.expiresAtEpochMs > Date.now() + REFRESH_EARLY_MS) return token;
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: this.oauthClientId });
    const response = record(await fetchJson(this.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }));
    if (!response || !tokenText(response.access_token) ||
        !(response.refresh_token === undefined || tokenText(response.refresh_token)) ||
        typeof response.expires_in !== "number" || !Number.isFinite(response.expires_in) || response.expires_in <= 0) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned an invalid response");
    }
    const refreshed: PersistedCloudToken = {
      accessToken: response.access_token,
      refreshToken: typeof response.refresh_token === "string" ? response.refresh_token : token.refreshToken,
      expiresAtEpochMs: Date.now() + response.expires_in * 1000,
      ...(token.identity ? { identity: token.identity } : {}),
    };
    try { await writeOwnerFile(path, JSON.stringify(refreshed), raw); }
    catch (error) {
      if (retryOnChange && error instanceof CredentialChangedError) return this.readOrRefreshCloudToken(false);
      throw error;
    }
    return refreshed;
  }

  private async relayUrl(): Promise<URL> {
    const configured = this.relayUrlOverride;
    const stored = configured ? null : await readOwnerFile(join(this.secretsDirectory, "cloud-relay-url.bin"), true);
    return secureOrigin(configured || stored?.trim() || DEFAULT_RELAY_URL, "https:");
  }

  private async relayAuthorization(): Promise<{ accessToken: string; expiresAt: number; relayUrl: URL }> {
    const relayUrl = await this.relayUrl();
    const relayOrigin = relayUrl.href;
    if (this.relayToken?.relayOrigin === relayOrigin && this.relayToken.expiresAt > Date.now() + 5_000) {
      return { accessToken: this.relayToken.accessToken, expiresAt: this.relayToken.expiresAt, relayUrl };
    }
    if (this.relayTokenPending?.relayOrigin !== relayOrigin) this.relayTokenPending = {
      relayOrigin,
      promise: (async () => {
        const cloud = await this.cloudToken();
        if (!cloud) throw new ApiError(503, "upstream_unavailable", "T3 Connect is not signed in");
        const url = new URL("/v1/client/dpop-token", relayUrl);
        const form = new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: cloud.accessToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          requested_token_type: ACCESS_TOKEN_TYPE,
          resource: relayUrl.origin,
          scope: RELAY_SCOPES,
          client_id: "t3-web",
        });
        const result = record(await fetchJson(url, { method: "POST", headers: {
          "Content-Type": "application/x-www-form-urlencoded", DPoP: this.proof("POST", url),
        }, body: form }));
        if (!result || !tokenText(result.access_token) || result.issued_token_type !== ACCESS_TOKEN_TYPE ||
            result.token_type !== "DPoP" ||
            typeof result.expires_in !== "number" || result.expires_in <= 0 ||
            new Set(String(result.scope).split(/\s+/u)).size !== 2 ||
            !String(result.scope).split(/\s+/u).includes("environment:connect") ||
            !String(result.scope).split(/\s+/u).includes("environment:status")) {
          throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned an invalid response");
        }
        return { accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000, relayOrigin };
      })(),
    };
    const pending = this.relayTokenPending;
    try {
      this.relayToken = await pending.promise;
      return { accessToken: this.relayToken.accessToken, expiresAt: this.relayToken.expiresAt, relayUrl };
    } finally {
      if (this.relayTokenPending === pending) this.relayTokenPending = null;
    }
  }

  async createEnvironmentSession(environment: RelayEnvironment): Promise<EnvironmentSession> {
    const relay = await this.relayAuthorization();
    const connectUrl = new URL(`/v1/environments/${encodeURIComponent(environment.environmentId)}/connect`, relay.relayUrl);
    let connectedValue: unknown;
    try {
      connectedValue = await fetchJson(connectUrl, { method: "POST", headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Authorization: `DPoP ${relay.accessToken}`,
        DPoP: this.proof("POST", connectUrl, relay.accessToken),
      }, body: JSON.stringify({ clientProofKeyThumbprint: this.signer.thumbprint }) });
    } catch (error) {
      if (error instanceof ApiError && error.code === "upstream_auth_failed") this.relayToken = null;
      throw error;
    }
    const connected = record(connectedValue);
    const endpoint = record(connected?.endpoint);
    if (!connected || connected.environmentId !== environment.environmentId || !tokenText(connected.credential) || !endpoint) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned an invalid response");
    }
    const httpBaseUrl = secureOrigin(endpoint.httpBaseUrl, "https:");
    const wsBaseUrl = secureOrigin(endpoint.wsBaseUrl, "wss:");
    const tokenUrl = new URL("/oauth/token", httpBaseUrl);
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: connected.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: ACCESS_TOKEN_TYPE,
      scope: ENVIRONMENT_SCOPES,
      client_label: "Faceclaw T3 Bridge",
      client_device_type: "bot",
      client_os: process.platform,
    });
    const token = record(await fetchJson(tokenUrl, { method: "POST", headers: {
      "Content-Type": "application/x-www-form-urlencoded", DPoP: this.proof("POST", tokenUrl),
    }, body: form }));
    const scopes = typeof token?.scope === "string" ? new Set(token.scope.split(/\s+/u).filter(Boolean)) : null;
    if (!token || !tokenText(token.access_token) || token.issued_token_type !== ACCESS_TOKEN_TYPE ||
        token.token_type !== "DPoP" ||
        typeof token.expires_in !== "number" || token.expires_in <= 0 || scopes?.size !== 2 ||
        !scopes.has("orchestration:read") || !scopes.has("orchestration:operate")) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000, httpBaseUrl, wsBaseUrl };
  }

  private parseEnvironment(value: unknown): RelayEnvironment {
    const item = record(value), endpoint = record(item?.endpoint);
    if (!item || typeof item.environmentId !== "string" || !isSafeId(item.environmentId) || !labelText(item.label) || !endpoint ||
        typeof item.linkedAt !== "string" || item.linkedAt.length > 64 ||
        typeof endpoint.providerKind !== "string" || endpoint.providerKind.length === 0 ||
        endpoint.providerKind.length > 128 || /[\u0000-\u001f\u007f]/u.test(endpoint.providerKind)) {
      throw new Error("T3 Connect returned an invalid environment");
    }
    secureOrigin(endpoint.httpBaseUrl, "https:");
    secureOrigin(endpoint.wsBaseUrl, "wss:");
    return { environmentId: item.environmentId, label: item.label,
      endpoint: { httpBaseUrl: endpoint.httpBaseUrl as string, wsBaseUrl: endpoint.wsBaseUrl as string,
        providerKind: endpoint.providerKind as string }, linkedAt: item.linkedAt };
  }

  async discover(): Promise<readonly EnvironmentRegistration[]> {
    const cloud = await this.cloudToken();
    if (!cloud) return [];
    const relayUrl = await this.relayUrl();
    const result = record(await fetchJson(new URL("/v1/environments", relayUrl), {
      method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${cloud.accessToken}` },
    }));
    if (!result || !Array.isArray(result.environments) || result.environments.length > 128) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned an invalid response");
    }
    const environments = result.environments.map((item) => this.parseEnvironment(item));
    const ids = new Set<string>();
    for (const environment of environments) {
      if (ids.has(environment.environmentId)) {
        throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned duplicate environments");
      }
      ids.add(environment.environmentId);
    }
    for (const environmentId of this.authorizations.keys()) {
      if (!ids.has(environmentId)) this.authorizations.delete(environmentId);
    }
    return Promise.all(environments.map(async (environment): Promise<EnvironmentRegistration> => {
      const fallback: T3Descriptor = { environmentId: environment.environmentId, label: environment.label,
        serverVersion: "unknown", capabilities: { threadSettlement: true } };
      try {
        const endpointKey = JSON.stringify(environment.endpoint);
        let cached = this.authorizations.get(environment.environmentId);
        if (!cached || cached.endpointKey !== endpointKey) {
          cached = { endpointKey, authorization: new RemoteEnvironmentAuthorization(this, environment) };
          this.authorizations.set(environment.environmentId, cached);
        }
        const config = { ...this.config, t3BaseUrl: new URL(environment.endpoint.httpBaseUrl), t3AccessToken: null };
        const client = new HttpT3Client(config, cached.authorization);
        const descriptor = await client.descriptor();
        if (descriptor.environmentId !== environment.environmentId || descriptor.capabilities.threadSettlement !== true) {
          throw new ApiError(502, "upstream_invalid_response", "T3 Connect returned a different environment");
        }
        return { descriptor: { ...descriptor, label: environment.label }, kind: "t3-connect", client, status: "connected" };
      } catch {
        return { descriptor: fallback, kind: "t3-connect", client: null, status: "offline",
          errorCode: "environment_unavailable" };
      }
    }));
  }
}
