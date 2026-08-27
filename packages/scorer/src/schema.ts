import { z } from "zod";

export const CONFIDENCE_THRESHOLD = 0.6;

export const SignalSchema = z.object({
  pass: z.boolean().describe("Whether this signal is satisfied."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How sure you are of this pass/fail call, 0-1 — NOT how good the issue is. A signal that is clearly absent is a CONFIDENT fail (0.8-1.0), not an uncertain one. Reserve low values for cases where you genuinely cannot tell either way.",
    ),
  rationale: z.string().describe("One short sentence explaining the judgment."),
});
export type Signal = z.infer<typeof SignalSchema>;

// Layer A: is the issue well-specified enough to act on at all.
export const ReadinessSchema = z.object({
  outcome: SignalSchema.describe("Would you know when this issue is done?"),
  scope: SignalSchema.describe(
    "Is this ONE change? Several related changes are still several changes -- a list of distinct edits fails this even when they share a theme or a file.",
  ),
  context: SignalSchema.describe(
    "Are the relevant files or reproduction steps identified in this repo (not assumed knowledge)?",
  ),
  ambiguity: SignalSchema.describe(
    "Is the issue free of undefined or subjective terms doing the real work?",
  ),
  suggestion: z
    .string()
    .describe(
      "One concrete rewrite suggestion targeting the weakest signal above. Empty string if all four signals pass.",
    ),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

/**
 * Readiness plus a grounding check, used when repository context is available.
 * Grounding is deliberately NOT part of the /4 score: the score measures how
 * well the issue is written, and an issue can be written perfectly while being
 * factually wrong about the codebase. It gates delegation instead.
 */
export const GroundedReadinessSchema = ReadinessSchema.extend({
  grounding: SignalSchema.describe(
    "Does this issue's description of the EXISTING code match reality? Fail only when it asserts something exists that the provided repository context reports as NOT FOUND. Proposing new code that does not exist yet is a feature request, not a grounding failure.",
  ),
});
export type GroundedReadiness = z.infer<typeof GroundedReadinessSchema>;

// Layer B: is it safe to delegate to an autonomous agent, independent of clarity.
export const DelegationSchema = ReadinessSchema.extend({
  taskPattern: SignalSchema.describe(
    "Pass = this is a recognizable, previously-common kind of change (rename, import fix, config bump, dependency bump, test/snapshot update), not novel or design-driven work.",
  ),
  blastRadius: SignalSchema.describe(
    "CATEGORICAL, not a risk judgment. Fail if the change touches auth, database schema/data migrations (including a 'simple' column rename), billing, public API surfaces, or adds/removes/replaces an external dependency. Simplicity is not an exemption. Sole exception: a version bump of a dependency already in use.",
  ),
});
export type Delegation = z.infer<typeof DelegationSchema>;
