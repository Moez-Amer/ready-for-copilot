import { z } from "zod";

/** Hard ceiling on decomposition. Unbounded splitting produces 30 tickets and despair. */
export const MAX_SUB_ISSUES = 8;

export const SubIssueSchema = z.object({
  title: z.string().describe("A specific, actionable issue title. No numbering prefix."),
  body: z
    .string()
    .describe(
      "The issue body: what to change, where, and a concrete way to tell when it is done.",
    ),
});
export type SubIssue = z.infer<typeof SubIssueSchema>;

export const DecompositionSchema = z.object({
  subIssues: z
    .array(SubIssueSchema)
    .describe(`Between 3 and ${MAX_SUB_ISSUES} sub-issues covering the parent issue's scope.`),
});
export type Decomposition = z.infer<typeof DecompositionSchema>;

export const DECOMPOSE_RUBRIC = `You break a large, hard-to-start GitHub issue into smaller sub-issues that can each be picked up independently.

Rules:
- Propose between 3 and ${MAX_SUB_ISSUES} sub-issues. Never more than ${MAX_SUB_ISSUES}.
- Together they should cover the parent issue's scope without overlapping each other.
- Split along natural seams in the work (per file, per component, per step), not arbitrary slices.
- Do not invent requirements the parent issue does not imply. If the parent is vague about something, keep that sub-issue narrow rather than guessing.

Every sub-issue you write is scored against the four signals below, and a sub-issue that fails any of them cannot be handed to a coding agent. Write each one so it passes all four on its own, read without the parent issue for context:

- outcome: state a concrete, checkable way to tell the work is done (a command that passes, a file that no longer contains something, a visible behaviour). "Updated to the new design" is not checkable; "renders with components from src/design-system/ and \`npm test\` passes" is.
- scope: exactly one bounded change per sub-issue. If you catch yourself writing "and", consider splitting again.
- context: name the actual files, directories, or components involved. Carry over every specific path the parent issue mentions into the sub-issue it belongs to. Never rely on the reader having seen the parent.
- ambiguity: no undefined or subjective terms doing the real work ("clean up", "improve", "properly", "as needed").

If a list of already-open issues is provided, do not propose a sub-issue for work one of them already covers. Splitting is meant to create work that does not exist yet; re-filing an open issue under a new number leaves two tickets for one task and no way to tell which is authoritative. Cover the remainder of the parent issue and leave the rest alone. If the open issues already cover everything the parent describes, return no sub-issues at all.

Write each body as a real issue body someone could act on cold, not a summary of what you did.

Two habits to avoid, because they quietly make an otherwise-actionable sub-issue undelegatable:

1. Catch-all preservation clauses — "preserve all existing functionality", "keep behaviour the same", "maintain current props". They sound careful but are unverifiable. If behaviour must hold, name the check that proves it instead: "\`npm test -- src/foo/\` still passes".
2. Subjective review steps — "review each diff for regressions", "ensure nothing looks off", "verify it works properly". Replace with a concrete command, assertion, or observable state, or drop the line entirely.

Also: a bullet list of five component types is five changes, not one. Either split it further, or scope that sub-issue to a single file or directory.

Finally, be honest when work genuinely needs a human. Some tasks — visual design, UX judgement, API shape decisions — have no objective done-condition, and no amount of wording makes them checkable. Do not dress those up with an official-sounding but hollow criterion ("renders correctly", "looks consistent"). Write them plainly and let them be judged as they are. A sub-issue honestly marked as needing judgement is a correct outcome; one disguised as mechanical gets handed to an agent that cannot do it.`;
