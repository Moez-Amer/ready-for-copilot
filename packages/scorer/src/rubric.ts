export const READINESS_RUBRIC = `You evaluate whether a GitHub issue is well-specified enough for a coding agent to act on safely, without a human clarifying anything first.

Score these four signals about the issue below. For each: pass/fail, a confidence from 0 to 1, and a one-sentence rationale.

- outcome: Would you know when this issue is done? Pass only if there is a concrete, checkable way to tell.
- scope: Is this one bounded change, not several unrelated changes bundled together?
- context: Are the relevant files, repo location, or reproduction steps identified — inside this repository, not assumed knowledge?
- ambiguity: Is the issue free of undefined or subjective terms doing the real work (e.g. "fix the bug", "make it better")?

Then write one concrete rewrite suggestion aimed at whichever signal scored weakest (lowest confidence, or a fail). If all four signals clearly pass, return an empty string for the suggestion.

On confidence: confidence measures how sure you are of the pass/fail call itself, NOT how good the issue is. An issue that plainly lacks a signal is a CONFIDENT fail — score it pass=false with high confidence (0.8-1.0). "Fix the login bug" fails all four signals confidently; it is not an uncertain case. Reserve low confidence (below 0.6) for when you genuinely cannot tell either way, such as an issue referring to files, discussions, or context you cannot see. Do not assume any information beyond what's in the title and body.`;

/**
 * Appended to the readiness rubric when repository context is available.
 * The feature-request carve-out matters: "add dark mode" describes code that
 * does not exist, and that is the entire point of a feature request, not a
 * defect in the issue.
 */
export const GROUNDING_RUBRIC = `
You are also given context about what this repository actually contains: its file layout, and the result of looking up every path and symbol this issue names. Use it to score one more signal:

- grounding: Does this issue's description of the EXISTING code match reality?
  * Fail it when the issue asserts something is already there and the context reports it NOT FOUND — a function, file, directory, or column it says to modify, rename, or fix.
  * Pass it when the issue proposes something new. "Add dark mode", "create a settings page", "we need a retry helper" all describe code that does not exist yet; that is what a feature request is, and it is not a grounding failure. Judge instead whether the surrounding claims hold — if it says to add a helper to a directory that does not exist, that is a real problem.
  * Pass it when nothing in the issue makes a checkable claim about existing code.
  * Where a lookup says "could not verify", do not treat that as a failure. Unknown is not the same as absent.

An issue can be written beautifully and still fail grounding. That is the point of this signal: a fluent description of code that is not there is exactly the kind of issue that wastes an agent's time.`;

export const DELEGATION_RUBRIC = `You evaluate a sub-issue to decide whether it is safe to hand to an autonomous coding agent with no human review of the plan, or whether a human should own it instead.

First, score the same four readiness signals as below: outcome, scope, context, ambiguity.

- outcome: Would you know when this issue is done? Pass only if there is a concrete, checkable way to tell.
- scope: Is this one bounded change, not several unrelated changes bundled together?
- context: Are the relevant files, repo location, or reproduction steps identified — inside this repository, not assumed knowledge?
- ambiguity: Is the issue free of undefined or subjective terms doing the real work (e.g. "fix the bug", "make it better")?

Then score two additional signals that are about safety, not clarity:

- taskPattern: Is this a recognizable, previously-common kind of change (e.g. rename, import fix, config bump, dependency version bump, test/snapshot update) rather than novel or design-driven work? Pass = yes, it's a routine pattern.
- blastRadius: This is a CATEGORICAL test, not a risk assessment. Fail it if the change touches ANY of these, regardless of how simple, routine, or low-risk the specific change seems:
    * authentication or authorization
    * database schema or data migrations — a schema migration is a data migration even when the change is "just" a column rename, an added index, or a default value
    * billing or payments
    * public API surfaces, including response shapes consumed by third parties
    * adding, removing, or replacing an external dependency, or changing which external service is called
  Do not reason your way past this list. "It's only a rename", "this migration is trivial", and "the interface stays the same" are not exemptions — the category is what matters, because these are the changes where an unreviewed mistake is expensive to undo.
  One narrow exception: a routine version bump of a dependency already in use (same interface, patch/minor update) does NOT fail this signal. The risk there is changing *what* the code depends on, not maintaining an existing pin.

Bias toward failing taskPattern or blastRadius when you are unsure — a false "safe" here means an agent ships an unreviewed change into something sensitive.

On confidence: confidence measures how sure you are of the pass/fail call itself, NOT how good or safe the sub-issue is. A signal that plainly fails is a CONFIDENT fail (0.8-1.0), not an uncertain one. Reserve low confidence (below 0.6) for when you genuinely cannot tell either way, such as a sub-issue referring to files or context you cannot see.

Also fill in the "suggestion" field as one concrete rewrite suggestion aimed at whichever of the four readiness signals scored weakest. Empty string if all four clearly pass.`;
