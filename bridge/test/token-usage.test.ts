import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTokenUsage } from "../src/token-usage.js";
import type { T3ThreadActivity } from "../src/types.js";
const at = (minute: number) => `2026-09-09T12:${String(minute).padStart(2, "0")}:00.000Z`;
const usage = (minute: number, usedTokens: unknown, totalProcessedTokens?: unknown, maxTokens?: unknown): T3ThreadActivity => ({
  kind: "context-window.updated", createdAt: at(minute), payload: { usedTokens, totalProcessedTokens, maxTokens },
});
test("context shrinks after compaction while cumulative processing stays monotonic", () => {
  const events = [usage(1, 48_000, 100_000, 272_000), usage(2, 90_000, 312_000, 272_000), usage(3, 24_000, 312_000, 272_000)];
  assert.deepEqual(normalizeTokenUsage(events), { contextTokens: 24_000, contextWindowTokens: 272_000, totalTokens: 312_000, latestTotalTokens: 312_000, updatedAt: at(3) });
  assert.deepEqual(normalizeTokenUsage([...events, ...events]), normalizeTokenUsage(events));
  assert.deepEqual(normalizeTokenUsage([...events].reverse()), normalizeTokenUsage(events));
});
test("repeated usage and stale totals do not add or erase already reported usage", () => {
  assert.deepEqual(normalizeTokenUsage([usage(1, 50, 120), usage(2, 80, 120), usage(3, 20), usage(4, 25, 100)]), {
    contextTokens: 25, contextWindowTokens: null, totalTokens: 120, latestTotalTokens: 100, updatedAt: at(4),
  });
});
test("missing cumulative data is unknown, never an estimate from context or component fields", () => {
  assert.deepEqual(normalizeTokenUsage(undefined), { contextTokens: null, contextWindowTokens: null, totalTokens: null, latestTotalTokens: null, updatedAt: null });
  assert.deepEqual(normalizeTokenUsage([{ ...usage(1, 42), payload: { usedTokens: 42, inputTokens: 30, cachedInputTokens: 20, outputTokens: 12, reasoningOutputTokens: 8 } }]), {
    contextTokens: 42, contextWindowTokens: null, totalTokens: null, latestTotalTokens: null, updatedAt: at(1),
  });
});
test("rejects malformed, fractional and unsafe counters without exporting raw payloads", () => {
  for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "80", {}, null]) {
    assert.deepEqual(normalizeTokenUsage([usage(1, 10, 20), usage(2, invalid, 100)]), { contextTokens: 10, contextWindowTokens: null, totalTokens: 20, latestTotalTokens: 20, updatedAt: at(1) });
    assert.equal(normalizeTokenUsage([usage(1, 10, invalid)]).totalTokens, null);
  }
  const other = { ...usage(5, 500, 900), kind: "task.progress", payload: { usedTokens: 500, totalProcessedTokens: 900, secret: "private" } };
  assert.deepEqual(normalizeTokenUsage([other, { ...usage(1, 2, 3), createdAt: "bad-date" }, usage(2, 0, 0)]), { contextTokens: 0, contextWindowTokens: null, totalTokens: 0, latestTotalTokens: 0, updatedAt: at(2) });
});
test("uses the active snapshot context limit and rejects invalid limits", () => {
  assert.deepEqual(normalizeTokenUsage([usage(1, 48_000, 100_000, 272_000), usage(2, 22_000, 120_000, 128_000)]), {
    contextTokens: 22_000, contextWindowTokens: 128_000, totalTokens: 120_000, latestTotalTokens: 120_000, updatedAt: at(2),
  });
  for (const invalid of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "272000", {}, null]) {
    assert.equal(normalizeTokenUsage([usage(1, 10, 20, invalid)]).contextWindowTokens, null);
  }
});
