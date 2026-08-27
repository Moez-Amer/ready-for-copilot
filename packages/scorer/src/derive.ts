import {
  CONFIDENCE_THRESHOLD,
  type Delegation,
  type GroundedReadiness,
  type Readiness,
  type Signal,
} from "./schema.js";

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
  /**
   * Whether the issue's claims about existing code check out.
   * `null` when repository context wasn't available, which is different from
   * `false` -- unverified is not the same as contradicted.
   */
  grounded: boolean | null;
  /** Why grounding failed, when it did. */
  groundingRationale: string | null;
}

/** Layer A only — used by the Linter. Pure function of the model's raw output. */
export function deriveReadinessResult(raw: Readiness | GroundedReadiness): ReadinessResult {
  const layerA = [raw.outcome, raw.scope, raw.context, raw.ambiguity];
  const grounding = "grounding" in raw ? raw.grounding : null;
  return {
    raw,
    score: layerA.filter((s) => s.pass).length,
    confident: minConfidence(layerA) >= CONFIDENCE_THRESHOLD,
    suggestion: raw.suggestion,
    // A low-confidence grounding call is treated as unverified, not failed --
    // the signal should only ever block delegation when it is sure.
    grounded:
      grounding === null
        ? null
        : grounding.confidence < CONFIDENCE_THRESHOLD
          ? null
          : grounding.pass,
    groundingRationale: grounding && !grounding.pass ? grounding.rationale : null,
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
