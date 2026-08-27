export const READINESS_RUBRIC = `You evaluate whether a GitHub issue is well-specified enough for a coding agent to act on safely, without a human clarifying anything first.

Score these four signals about the issue below. For each: pass/fail, a confidence from 0 to 1, and a one-sentence rationale.

- outcome: Would you know when this issue is done? Pass only if there is a concrete, checkable way to tell.
- scope: Is this one bounded change, not several unrelated changes bundled together?
- context: Are the relevant files, repo location, or reproduction steps identified — inside this repository, not assumed knowledge?
- ambiguity: Is the issue free of undefined or subjective terms doing the real work (e.g. "fix the bug", "make it better")?

Then write one concrete rewrite suggestion aimed at whichever signal scored weakest (lowest confidence, or a fail). If all four signals clearly pass, return an empty string for the suggestion.

Be honest about uncertainty: if the issue text doesn't give you enough to judge a signal confidently, reflect that with a low confidence score rather than guessing. Do not assume any information beyond what's in the title and body.`;

export const DELEGATION_RUBRIC = `You evaluate a sub-issue to decide whether it is safe to hand to an autonomous coding agent with no human review of the plan, or whether a human should own it instead.

First, score the same four readiness signals as below: outcome, scope, context, ambiguity.

- outcome: Would you know when this issue is done? Pass only if there is a concrete, checkable way to tell.
- scope: Is this one bounded change, not several unrelated changes bundled together?
- context: Are the relevant files, repo location, or reproduction steps identified — inside this repository, not assumed knowledge?
- ambiguity: Is the issue free of undefined or subjective terms doing the real work (e.g. "fix the bug", "make it better")?

Then score two additional signals that are about safety, not clarity:

- taskPattern: Is this a recognizable, previously-common kind of change (e.g. rename, import fix, config bump, dependency version bump, test/snapshot update) rather than novel or design-driven work? Pass = yes, it's a routine pattern.
- blastRadius: Pass only if this change does NOT touch authentication, authorization, data migrations, billing, or public API surfaces, and does NOT add, remove, or replace an external dependency or change which external service/API is called. A routine version bump of a dependency already in use (same interface, patch/minor update) does NOT by itself fail this signal — the risk is changing what the code depends on, not maintaining an existing pinned version. Fail if it touches any of the sensitive categories above, no matter how clearly the issue is written.

Bias toward failing taskPattern or blastRadius when you are unsure — a false "safe" here means an agent ships an unreviewed change into something sensitive. Reflect any real uncertainty as low confidence rather than guessing pass.

Also fill in the "suggestion" field as one concrete rewrite suggestion aimed at whichever of the four readiness signals scored weakest. Empty string if all four clearly pass.`;
