import { CONFIDENCE_THRESHOLD, type Delegation, type Readiness, type Signal } from "./schema.js";

function minConfidence(signals: Signal[]): number {
  return Math.min(...signals.map((s) => s.confidence));
}

export interface ReadinessResult {
  raw: Readiness;
  /** Count of the four Layer A signals that passed, 0-4. */
  score: number;
  /** False if the model wasn't confident enough in its own judgment to trust the score. */
  confident: boolean;
  suggestion: string;
}

/** Layer A only — used by the Linter. Pure function of the model's raw output. */
export function deriveReadinessResult(raw: Readiness): ReadinessResult {
  const layerA = [raw.outcome, raw.scope, raw.context, raw.ambiguity];
  return {
    raw,
    score: layerA.filter((s) => s.pass).length,
    confident: minConfidence(layerA) >= CONFIDENCE_THRESHOLD,
    suggestion: raw.suggestion,
  };
}

export interface DelegationResult {
  raw: Delegation;
  layerAScore: number;
  /** False if the model wasn't confident enough across all six signals. */
  confident: boolean;
  classification: "mechanical" | "judgement";
}

/**
 * Layer A + Layer B — used by /split's classify step.
 * Mechanical requires a perfect, confident Layer A score AND both Layer B
 * safety signals to pass. Any doubt, on either layer, falls back to
 * "judgement" — being wrong here ships a confident, unreviewed PR.
 */
export function deriveDelegationResult(raw: Delegation): DelegationResult {
  const layerA = [raw.outcome, raw.scope, raw.context, raw.ambiguity];
  const layerB = [raw.taskPattern, raw.blastRadius];
  const layerAScore = layerA.filter((s) => s.pass).length;
  const confident = minConfidence([...layerA, ...layerB]) >= CONFIDENCE_THRESHOLD;
  const mechanical = confident && layerAScore === 4 && raw.taskPattern.pass && raw.blastRadius.pass;
  return {
    raw,
    layerAScore,
    confident,
    classification: mechanical ? "mechanical" : "judgement",
  };
}
