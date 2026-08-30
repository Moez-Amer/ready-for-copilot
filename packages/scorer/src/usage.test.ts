import { beforeEach, describe, expect, it } from "vitest";
import { estimateCost, formatUsage, recordUsage, resetUsage, usageSummary } from "./usage.js";

beforeEach(() => resetUsage());

describe("estimateCost", () => {
  it("prices input and output at their separate rates", () => {
    // Defaults: $1/M input, $5/M output.
    const cost = estimateCost({
      label: "t",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(6, 5);
  });

  it("prices cache reads far below fresh input", () => {
    const cached = estimateCost({
      label: "t", inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 0,
    });
    const fresh = estimateCost({
      label: "t", inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(cached).toBeLessThan(fresh);
    expect(cached).toBeCloseTo(fresh * 0.1, 5);
  });
});

describe("usageSummary", () => {
  it("accumulates across calls", () => {
    recordUsage("a", { input_tokens: 100, output_tokens: 10 });
    recordUsage("b", { input_tokens: 200, output_tokens: 20 });
    const s = usageSummary();
    expect(s.calls).toBe(2);
    expect(s.inputTokens).toBe(300);
    expect(s.outputTokens).toBe(30);
  });

  it("states what the run would have cost without caching", () => {
    recordUsage("a", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 10_000 });
    const s = usageSummary();
    expect(s.costWithoutCacheUsd).toBeGreaterThan(s.estimatedCostUsd);
  });

  it("ignores a call that reported no usage", () => {
    expect(recordUsage("a", undefined)).toBeNull();
    expect(usageSummary().calls).toBe(0);
  });
});

describe("formatUsage", () => {
  it("mentions the cache saving only when there is one", () => {
    recordUsage("a", { input_tokens: 100, output_tokens: 10 });
    expect(formatUsage(usageSummary())).not.toContain("saved");
    resetUsage();
    recordUsage("b", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500_000 });
    expect(formatUsage(usageSummary())).toContain("saved");
  });
});
