import type { T3ThreadActivity } from "./types.js";

export interface SessionTokenUsage {
  readonly contextTokens: number | null;
  readonly contextWindowTokens: number | null;
  readonly totalTokens: number | null;
  /** Cumulative counter on the newest context event, before lifetime folding. */
  readonly latestTotalTokens: number | null;
  readonly updatedAt: string | null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * T3 projects provider usage into context-window.updated activities. usedTokens
 * is current occupancy; totalProcessedTokens already includes previous turns.
 * Never sum those cumulative snapshots, cached-input or reasoning subtotals.
 * Source contract: T3 Code 8ea52c8, providerRuntime.ts / CodexAdapter.ts /
 * ClaudeAdapter.ts. Providers without cumulative usage remain unknown.
 */
export function normalizeTokenUsage(activities: readonly T3ThreadActivity[] | undefined): SessionTokenUsage {
  let contextTokens: number | null = null;
  let contextWindowTokens: number | null = null;
  let totalTokens: number | null = null;
  let latestTotalTokens: number | null = null;
  let updatedAt: string | null = null;
  let latest = -Infinity;
  if (!Array.isArray(activities)) return { contextTokens, contextWindowTokens, totalTokens, latestTotalTokens, updatedAt };
  for (const activity of activities) {
    if (!activity || activity.kind !== "context-window.updated" ||
        typeof activity.createdAt !== "string" || activity.createdAt.length > 40) continue;
    const time = Date.parse(activity.createdAt);
    if (!Number.isFinite(time) || !activity.payload || typeof activity.payload !== "object" || Array.isArray(activity.payload)) continue;
    const payload = activity.payload as Record<string, unknown>;
    const used = tokenCount(payload.usedTokens);
    if (used === null) continue;
    const total = tokenCount(payload.totalProcessedTokens);
    // Repeated snapshots, older events and a compaction do not spend tokens.
    if (total !== null) totalTokens = Math.max(totalTokens ?? 0, total);
    if (time >= latest) {
      latest = time;
      contextTokens = used;
      const max = tokenCount(payload.maxTokens);
      contextWindowTokens = max !== null && max > 0 ? max : null;
      latestTotalTokens = total;
      updatedAt = activity.createdAt;
    }
  }
  return { contextTokens, contextWindowTokens, totalTokens, latestTotalTokens, updatedAt };
}
