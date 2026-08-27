import {
  CONFIDENCE_THRESHOLD,
  type Delegation,
  type GroundedDelegation,
  type GroundedReadiness,
  type Readiness,
  type Signal,
} from "./schema.js";

function minConfidence(signals: Signal[]): number {
  return Math.min(...signals.map((s) => s.confidence));
}

export interface ReadinessResult {
  raw: Readiness;
  /** What the author is doing: asking for a change, asking a question, or raising a topic. */
  kind: Readiness["kind"];
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
    kind: raw.kind,
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

/**
 * Words an issue opens with when it is asking rather than requesting.
 * A title that starts otherwise, and carries no question mark, is asking for
 * work -- however badly it says so.
 */
const INTERROGATIVE =
  /^\s*(how|what|why|when|where|which|who|whose|should|shall|could|can|would|will|is|are|was|were|does|do|did|has|have|any(one|body)?|thoughts|opinions|discussion|question|rfc|proposal)\b/i;

/**
 * Whether a title reads as a request for work rather than a question or a
 * topic for debate.
 *
 * The model misfiles softly-worded requests -- "make the docs better", "the
 * readme could use some work" -- as discussion, and two rounds of sharpening
 * the rubric did not fix it. The consequence is asymmetric: a question
 * mistaken for work gets an unnecessary rewrite suggestion, while work
 * mistaken for discussion escapes scoring and its author gets no help at all.
 * So the code leans the safe way rather than trusting the classification.
 */
export function titleAsksForWork(title: string): boolean {
  if (title.includes("?")) return false;
  return !INTERROGATIVE.test(title);
}

export interface AssessmentResult extends ReadinessResult {
  /** Whether this is safe to hand to an agent unreviewed. */
  classification: "mechanical" | "judgement";
  /** Why it needs a human, when it does. */
  judgementReason: string | null;
}

/**
 * The full picture for one issue: how well it is written, whether it is true,
 * and whether it is safe to delegate.
 *
 * The Linter needs all three. Labelling an issue agent-ready on readiness
 * alone promised "safe for an agent" while never running the safety check --
 * a well-written change to a secret reference scored 4/4 and earned the label.
 */
export function deriveAssessment(
  raw: GroundedDelegation | Delegation,
  title = "",
): AssessmentResult {
  const readiness = deriveReadinessResult(raw as never);
  // Override a non-work classification when the title plainly asks for work.
  if (readiness.kind !== "change-request" && title && titleAsksForWork(title)) {
    readiness.kind = "change-request";
  }
  const delegation = deriveDelegationResult(raw);
  const reason = !raw.blastRadius.pass
    ? raw.blastRadius.rationale
    : !raw.taskPattern.pass
      ? raw.taskPattern.rationale
      : null;
  return {
    ...readiness,
    classification: delegation.classification,
    judgementReason: delegation.classification === "judgement" ? reason : null,
  };
}
