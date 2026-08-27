import { describe, expect, it } from "vitest";
import { deriveDelegationResult, deriveReadinessResult } from "./derive.js";
import type { Delegation, Readiness, Signal } from "./schema.js";

function signal(pass: boolean, confidence = 0.9): Signal {
  return { pass, confidence, rationale: "test" };
}

function readiness(overrides: Partial<Readiness> = {}): Readiness {
  return {
    outcome: signal(true),
    scope: signal(true),
    context: signal(true),
    ambiguity: signal(true),
    suggestion: "",
    ...overrides,
  };
}

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    ...readiness(),
    taskPattern: signal(true),
    blastRadius: signal(true),
    ...overrides,
  };
}

describe("deriveReadinessResult", () => {
  it("scores 4/4 when every Layer A signal passes", () => {
    const result = deriveReadinessResult(readiness());
    expect(result.score).toBe(4);
    expect(result.confident).toBe(true);
  });

  it("scores partial credit when some signals fail", () => {
    const result = deriveReadinessResult(readiness({ scope: signal(false), ambiguity: signal(false) }));
    expect(result.score).toBe(2);
  });

  it("is not confident if any single signal has low confidence", () => {
    const result = deriveReadinessResult(readiness({ context: signal(true, 0.2) }));
    expect(result.confident).toBe(false);
  });

  it("passes the model's suggestion through unchanged", () => {
    const result = deriveReadinessResult(readiness({ suggestion: "name the file to change" }));
    expect(result.suggestion).toBe("name the file to change");
  });
});

describe("deriveDelegationResult", () => {
  it("classifies mechanical only when Layer A is a perfect, confident 4/4 and both Layer B signals pass", () => {
    const result = deriveDelegationResult(delegation());
    expect(result.layerAScore).toBe(4);
    expect(result.classification).toBe("mechanical");
  });

  it("falls back to judgement when blastRadius fails, even at a perfect Layer A score", () => {
    const result = deriveDelegationResult(delegation({ blastRadius: signal(false) }));
    expect(result.layerAScore).toBe(4);
    expect(result.classification).toBe("judgement");
  });

  it("falls back to judgement when taskPattern fails", () => {
    const result = deriveDelegationResult(delegation({ taskPattern: signal(false) }));
    expect(result.classification).toBe("judgement");
  });

  it("falls back to judgement when Layer A is not a perfect 4/4", () => {
    const result = deriveDelegationResult(delegation({ scope: signal(false) }));
    expect(result.classification).toBe("judgement");
  });

  it("falls back to judgement when confidence is low on any signal, even if every signal passes", () => {
    const result = deriveDelegationResult(delegation({ blastRadius: signal(true, 0.3) }));
    expect(result.classification).toBe("judgement");
  });
});
