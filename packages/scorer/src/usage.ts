/**
 * What one model call consumed. Token counts come straight from the API
 * response, so they are measured rather than estimated; only the money is
 * inferred, from configurable rates.
 */
export interface CallUsage {
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Dollars per million tokens.
 *
 * Bedrock pricing is set by AWS, varies by region and inference profile, and
 * changes -- so these are overridable defaults rather than authority. Cache
 * reads bill at roughly a tenth of input; cache writes at roughly 1.25x.
 * Override with RELAY_RATE_INPUT / RELAY_RATE_OUTPUT to match your own bill.
 */
function rates() {
  const input = Number(process.env.RELAY_RATE_INPUT ?? 1);
  const output = Number(process.env.RELAY_RATE_OUTPUT ?? 5);
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}

export function estimateCost(usage: CallUsage): number {
  const r = rates();
  return (
    (usage.inputTokens * r.input +
      usage.outputTokens * r.output +
      usage.cacheReadTokens * r.cacheRead +
      usage.cacheWriteTokens * r.cacheWrite) /
    1_000_000
  );
}

const calls: CallUsage[] = [];

/** Record one call. Shape matches the SDK's usage object, loosely typed so a new field cannot break this. */
export function recordUsage(
  label: string,
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | undefined,
): CallUsage | null {
  if (!usage) return null;
  const call: CallUsage = {
    label,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
  calls.push(call);
  return call;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated, because the rates are configurable and Bedrock's vary. */
  estimatedCostUsd: number;
  /** What the same work would have cost with nothing served from cache. */
  costWithoutCacheUsd: number;
}

/** Everything recorded so far. */
export function usageSummary(): UsageSummary {
  const r = rates();
  const total = calls.reduce(
    (acc, c) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + c.inputTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + c.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + c.cacheWriteTokens,
      estimatedCostUsd: acc.estimatedCostUsd + estimateCost(c),
    }),
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    },
  );

  // Cached tokens would have been billed as ordinary input without caching,
  // which is the only honest way to state what caching is worth.
  const uncachedEquivalent =
    ((total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens) * r.input +
      total.outputTokens * r.output) /
    1_000_000;

  return { ...total, costWithoutCacheUsd: uncachedEquivalent };
}

/** Clear the record. Used between runs and in tests. */
export function resetUsage(): void {
  calls.length = 0;
}

/** A line fit for a run log. */
export function formatUsage(summary: UsageSummary): string {
  const saved = summary.costWithoutCacheUsd - summary.estimatedCostUsd;
  const savedNote =
    saved > 0.00005 ? `, saved ~$${saved.toFixed(4)} via cache` : "";
  return (
    `${summary.calls} model call${summary.calls === 1 ? "" : "s"}: ` +
    `${summary.inputTokens.toLocaleString()} in, ` +
    `${summary.outputTokens.toLocaleString()} out, ` +
    `${summary.cacheReadTokens.toLocaleString()} cached — ` +
    `~$${summary.estimatedCostUsd.toFixed(4)}${savedNote}`
  );
}
