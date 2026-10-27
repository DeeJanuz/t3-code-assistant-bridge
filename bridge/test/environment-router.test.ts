import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManagedEnvironmentRouter } from "../src/environment-router.js";
import type { T3Client, T3Descriptor, T3ShellSnapshot } from "../src/types.js";

const descriptor = (environmentId: string, label: string): T3Descriptor => ({
  environmentId, label, serverVersion: "1", capabilities: { threadSettlement: true },
});
const shell = (snapshotSequence: number): T3ShellSnapshot => ({
  snapshotSequence, projects: [], threads: [], updatedAt: "2026-09-12T00:00:00.000Z",
});
const client = (value: T3ShellSnapshot | Error): T3Client => ({
  shell: async () => { if (value instanceof Error) throw value; return value; },
} as T3Client);

describe("managed T3 environment routing", () => {
  it("keeps local and account-linked clients distinct and defaults only to primary", async () => {
    const router = new ManagedEnvironmentRouter();
    const local = client(shell(1));
    const remote = client(shell(2));
    router.register({ descriptor: descriptor("local", "This computer"), kind: "local", client: local, primary: true });
    router.replaceKind("t3-connect", [
      { descriptor: descriptor("remote", "Studio Mac"), kind: "t3-connect", client: remote },
    ]);

    assert.equal((await router.resolve()).client, local);
    assert.equal((await router.resolve("remote")).client, remote);
    assert.deepEqual((await router.list()).map(item => [item.environmentId, item.isPrimary]), [
      ["local", true], ["remote", false],
    ]);
    await assert.rejects(router.resolve("missing"), (error: Error & { code?: string }) =>
      error.code === "upstream_unavailable");
  });

  it("reports partial availability without losing healthy environments", async () => {
    const router = new ManagedEnvironmentRouter();
    router.register({ descriptor: descriptor("local", "Local"), kind: "local", client: client(shell(3)), primary: true });
    router.replaceKind("t3-connect", [
      { descriptor: descriptor("remote", "Remote"), kind: "t3-connect", client: client(new Error("offline")) },
    ]);

    const snapshot = await router.snapshots();
    assert.deepEqual(snapshot.available.map(item => item.environment.environmentId), ["local"]);
    assert.deepEqual(snapshot.environments.map(item => [item.environmentId, item.status]), [
      ["local", "connected"], ["remote", "offline"],
    ]);
    await assert.rejects(router.resolve("remote"), /selected T3 environment is unavailable/);
  });

  it("does not let relay discovery replace the local primary with the same environment id", async () => {
    const router = new ManagedEnvironmentRouter();
    const local = client(shell(1));
    router.register({ descriptor: descriptor("same", "Local"), kind: "local", client: local, primary: true });
    router.replaceKind("t3-connect", [
      { descriptor: descriptor("same", "Relay copy"), kind: "t3-connect", client: client(shell(2)) },
    ]);
    assert.equal((await router.resolve("same")).client, local);
    assert.equal((await router.list())[0]?.kind, "local");
  });
});
