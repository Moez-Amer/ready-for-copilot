import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildRepoContext } from "@issue-triage/repo-context";
import { scoreReadiness, type ReadinessResult } from "@issue-triage/scorer";

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Every issue this bot scores ends up in exactly one of these states, so the
 * board can be filtered by what an issue actually needs next.
 */
const LABELS = {
  ready: {
    name: "agent-ready",
    color: "0e8a16",
    description: "Scored 4/4 and matches the codebase -- safe to hand to a coding agent.",
  },
  needsDetail: {
    name: "needs-detail",
    color: "fbca04",
    description: "Scored below 4/4 on agent-readiness -- see the bot's suggestion.",
  },
  notInCodebase: {
    name: "not-in-codebase",
    color: "b60205",
    description: "Describes files or symbols that don't exist in this repository.",
  },
} as const;

const MANAGED_LABELS: string[] = Object.values(LABELS).map((l) => l.name);

/** Identifies this bot's own comment so re-scoring updates it in place. */
const MARKER = "<!-- agent-readiness -->";

function formatComment(result: ReadinessResult): string {
  const suggestion = result.suggestion.trim();
  // Grounding is reported separately from the score: the score is about how
  // the issue is written, grounding is about whether it is true. A 4/4 that
  // describes code which isn't there is the case worth calling out loudest.
  const grounding =
    result.grounded === false && result.groundingRationale
      ? `\n\n⚠️ **This doesn't match the code:** ${result.groundingRationale}`
      : "";

  // The suggestion is the point of this bot -- it survives every path,
  // including the abstain path, where a rewrite is what the author needs most.
  if (!result.confident) {
    const header =
      "I can't score this issue confidently — there isn't enough here for me to judge it either way.";
    return (suggestion ? `${header}\n\n${suggestion}` : header) + grounding;
  }
  if (result.score === 4) {
    const headline =
      result.grounded === false
        ? "**Agent-readiness: 4/4 (writing) — but blocked**"
        : "**Agent-readiness: 4/4** — this issue looks ready for a coding agent to act on.";
    return headline + grounding;
  }
  return `**Agent-readiness: ${result.score}/4**\n\n${suggestion}${grounding}`;
}

/**
 * Which single label this result earns, or null when we can't judge.
 *
 * The label names the most useful next action, not every fault found. A
 * half-written issue needs detail whether or not its references check out, and
 * the comment reports the grounding problem either way. not-in-codebase is
 * reserved for the surprising case: an issue that reads as ready but describes
 * code that isn't there.
 */
function labelFor(result: ReadinessResult): string | null {
  if (!result.confident) return null;
  if (result.score < 4) return LABELS.needsDetail.name;
  return result.grounded === false ? LABELS.notInCodebase.name : LABELS.ready.name;
}

async function ensureLabelExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
): Promise<void> {
  const spec = Object.values(LABELS).find((l) => l.name === name);
  if (!spec) return;
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    await octokit.rest.issues.createLabel({ owner, repo, ...spec });
  }
}

/**
 * Apply the one label this issue has earned and clear any other label this bot
 * manages. Re-scoring an edited issue must not leave the previous verdict
 * sitting next to the new one.
 */
async function syncLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  desired: string | null,
): Promise<void> {
  const { data: current } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
  });
  const currentNames = current.map((l) => l.name);

  for (const name of MANAGED_LABELS) {
    if (name !== desired && currentNames.includes(name)) {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
    }
  }
  if (desired && !currentNames.includes(desired)) {
    await ensureLabelExists(octokit, owner, repo, desired);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [desired],
    });
  }
}

/**
 * One verdict per issue, edited in place. Re-scoring after every edit would
 * otherwise bury the issue under a column of near-identical bot comments.
 */
async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const withMarker = `${body}\n\n${MARKER}`;
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: withMarker });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: withMarker });
  }
}

async function run(): Promise<void> {
  // The scorer package reads AWS_BEARER_TOKEN_BEDROCK / AWS_REGION directly
  // from the environment (matching how it's used everywhere else in this
  // project); bridge the action's own inputs into that same environment
  // shape before the scorer's client is constructed.
  process.env.AWS_BEARER_TOKEN_BEDROCK = core.getInput("aws-bearer-token-bedrock", { required: true });
  process.env.AWS_REGION = core.getInput("aws-region") || "us-east-1";

  const githubToken = core.getInput("github-token", { required: true });
  const octokit = github.getOctokit(githubToken);
  const { owner, repo } = github.context.repo;

  const issue = github.context.payload.issue;
  if (!issue) {
    core.setFailed("This action must run on an `issues` event with an issue in the payload.");
    return;
  }

  const title = issue.title ?? "";
  const body = issue.body ?? "";

  // Grounding context is best-effort: if the repo can't be read, the issue is
  // still scored on its writing, just without the reality check.
  const repoContext = await buildRepoContext({
    octokit,
    owner,
    repo,
    issueText: `${title}\n${body}`,
  });
  if (!repoContext) {
    core.warning("Could not read repository context; scoring on issue text alone.");
  }

  const result = await scoreReadiness({ title, body, repoContext: repoContext ?? undefined });

  await upsertComment(octokit, owner, repo, issue.number, formatComment(result));
  await syncLabels(octokit, owner, repo, issue.number, labelFor(result));

  core.info(
    `#${issue.number}: ${result.score}/4 confident=${result.confident} grounded=${result.grounded} label=${labelFor(result) ?? "none"}`,
  );
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
