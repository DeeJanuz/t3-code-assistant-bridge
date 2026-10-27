import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { T3ConnectManager } from "../src/t3-connect.js";

const originalFetch = globalThis.fetch;
const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const directories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function baseDirectory(mode = 0o600): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "even-t3-connect-"));
  directories.push(base);
  const secrets = join(base, "userdata", "secrets");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  const path = join(secrets, "cloud-cli-oauth-token.bin");
  await writeFile(path, JSON.stringify({
    accessToken: "cloud-access", refreshToken: "cloud-refresh", expiresAtEpochMs: Date.now() + 60 * 60_000,
  }), { mode });
  await chmod(path, mode);
  return base;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function verifiedDpop(headers: Headers, method: string, url: string, token?: string): void {
  const compact = headers.get("dpop");
  assert.ok(compact);
  const [encodedHeader, encodedPayload, encodedSignature] = compact.split(".");
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(header.typ, "dpop+jwt");
  assert.equal(header.alg, "ES256");
  assert.equal(payload.htm, method);
  assert.equal(payload.htu, url);
  assert.equal(payload.ath, token ? createHash("sha256").update(token).digest("base64url") : undefined);
  const key = createPublicKey({ key: header.jwk, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key, dsaEncoding: "ieee-p1363" }, Buffer.from(encodedSignature, "base64url")), true);
}

describe("T3 Connect discovery", () => {
  it("discovers an account-linked environment and uses DPoP for environment traffic", { skip: process.platform === 'win32' && 'T3 Connect credentials use POSIX owner-only checks' }, async () => {
    const base = await baseDirectory();
    const calls: string[] = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      calls.push(`${method} ${url.href}`);
      if (url.href === "https://relay.example/v1/environments") {
        assert.equal(headers.get("authorization"), "Bearer cloud-access");
        return json({ environments: [{ environmentId: "remote-1", label: "Studio Mac", linkedAt: "2026-09-01T00:00:00.000Z",
          endpoint: { httpBaseUrl: "https://listed-endpoint.example", wsBaseUrl: "wss://listed-endpoint.example/ws", providerKind: "relay" } }] });
      }
      if (url.href === "https://relay.example/v1/client/dpop-token") {
        const form = new URLSearchParams(String(init.body));
        assert.equal(form.get("resource"), "https://relay.example");
        verifiedDpop(headers, "POST", url.href);
        return json({ access_token: "relay-access", issued_token_type: accessTokenType,
          token_type: "DPoP", expires_in: 600,
          scope: "environment:connect environment:status" });
      }
      if (url.href === "https://relay.example/v1/environments/remote-1/connect") {
        assert.equal(headers.get("authorization"), "DPoP relay-access");
        verifiedDpop(headers, "POST", url.href, "relay-access");
        const body = JSON.parse(String(init.body));
        assert.match(body.clientProofKeyThumbprint, /^[A-Za-z0-9_-]{43}$/);
        return json({ environmentId: "remote-1", credential: "bootstrap-credential",
          endpoint: { httpBaseUrl: "https://environment.example", wsBaseUrl: "wss://environment.example" } });
      }
      if (url.href === "https://environment.example/oauth/token") {
        verifiedDpop(headers, "POST", url.href);
        return json({ access_token: "environment-access", issued_token_type: accessTokenType,
          token_type: "DPoP", expires_in: 600,
          scope: "orchestration:read orchestration:operate" });
      }
      if (url.href === "https://environment.example/.well-known/t3/environment") {
        assert.equal(headers.get("authorization"), "DPoP environment-access");
        verifiedDpop(headers, "GET", url.href, "environment-access");
        return json({ environmentId: "remote-1", label: "Host label", serverVersion: "0.0.46",
          orchestrationProtocolVersion: 2, capabilities: { threadSettlement: true } });
      }
      if (url.href === "https://environment.example/api/orchestration/shell") {
        assert.equal(headers.get("authorization"), "DPoP environment-access");
        verifiedDpop(headers, "GET", url.href, "environment-access");
        assert.equal(headers.get("x-t3-orchestration-protocol"), "2");
        return json({ schemaVersion: 2, snapshotSequence: 9, projects: [], threads: [], archivedThreads: [] });
      }
      throw new Error(`Unexpected request: ${method} ${url.href}`);
    };

    const manager = new T3ConnectManager(loadConfig({
      BRIDGE_TOKEN: "abcdefghijklmnopqrstuvwxyzABCDEF", T3_ACCESS_TOKEN: "local-token",
    }), base, { T3CODE_RELAY_URL: "https://relay.example" });
    const discovered = await manager.discover();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.status, "connected");
    assert.equal(discovered[0]?.descriptor.label, "Studio Mac");
    assert.equal((await discovered[0]!.client!.shell()).snapshotSequence, 9);
    assert.deepEqual(calls, [
      "GET https://relay.example/v1/environments",
      "POST https://relay.example/v1/client/dpop-token",
      "POST https://relay.example/v1/environments/remote-1/connect",
      "POST https://environment.example/oauth/token",
      "GET https://environment.example/.well-known/t3/environment",
      "GET https://environment.example/api/orchestration/shell",
    ]);
  });

  it("rejects cloud credentials readable by another user before making network requests", async () => {
    const base = await baseDirectory(0o644);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json({}); };
    const manager = new T3ConnectManager(loadConfig({
      BRIDGE_TOKEN: "abcdefghijklmnopqrstuvwxyzABCDEF", T3_ACCESS_TOKEN: "local-token",
    }), base, { T3CODE_RELAY_URL: "https://relay.example" });
    await assert.rejects(manager.discover(), /permissions are unsafe/);
    assert.equal(calls, 0);
  });

  it("refreshes an expired CLI credential with an atomic owner-only replacement", { skip: process.platform === 'win32' && 'T3 Connect credentials use POSIX owner-only checks' }, async () => {
    const base = await baseDirectory();
    const tokenPath = join(base, "userdata", "secrets", "cloud-cli-oauth-token.bin");
    await writeFile(tokenPath, JSON.stringify({ accessToken: "expired-access", refreshToken: "old-refresh",
      expiresAtEpochMs: Date.now() - 1 }), { mode: 0o600 });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.href === "https://clerk.example/oauth/token") {
        assert.equal(init.method, "POST");
        const form = new URLSearchParams(String(init.body));
        assert.equal(form.get("refresh_token"), "old-refresh");
        return json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
      }
      if (url.href === "https://relay.example/v1/environments") {
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer fresh-access");
        return json({ environments: [] });
      }
      throw new Error(`Unexpected request: ${url.href}`);
    };
    const manager = new T3ConnectManager(loadConfig({
      BRIDGE_TOKEN: "abcdefghijklmnopqrstuvwxyzABCDEF", T3_ACCESS_TOKEN: "local-token",
    }), base, { T3CODE_RELAY_URL: "https://relay.example", T3_CONNECT_TOKEN_ENDPOINT: "https://clerk.example/oauth/token" });
    assert.deepEqual(await manager.discover(), []);
    const stored = JSON.parse(await readFile(tokenPath, "utf8"));
    assert.equal(stored.accessToken, "fresh-access");
    assert.equal(stored.refreshToken, "fresh-refresh");
    assert.equal((await stat(tokenPath)).mode & 0o077, 0);
  });
});
