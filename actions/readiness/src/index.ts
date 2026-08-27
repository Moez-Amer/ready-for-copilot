import * as core from "@actions/core";
import * as github from "@actions/github";
import { scoreReadiness, type ReadinessResult } from "@issue-triage/scorer";

const AGENT_READY_LABEL = "agent-ready";
const AGENT_READY_COLOR = "0e8a16";

function formatComment(result: ReadinessResult): string {
  const suggestion = result.suggestion.trim();
  // The suggestion is the point of this bot -- it survives every path,
  // including the abstain path, where a rewrite is what the author needs most.
  if (!result.confident) {
    const header =
      "I can't score this issue confidently — there isn't enough here for me to judge it either way.";
    return suggestion ? `${header}\n\n${suggestion}` : header;
  }
  if (result.score === 4) {
    return "**Agent-readiness: 4/4** — this issue looks ready for a coding agent to act on.";
  }
  return `**Agent-readiness: ${result.score}/4**\n\n${suggestion}`;
}

async function ensureLabelExists(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: AGENT_READY_LABEL });
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      throw err;
    }
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: AGENT_READY_LABEL,
      color: AGENT_READY_COLOR,
      description: "Scored 4/4 on the readiness rubric -- safe to hand to a coding agent.",
    });
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

  const result = await scoreReadiness({
    title: issue.title ?? "",
    body: issue.body ?? "",
  });

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body: formatComment(result),
  });

  if (result.confident && result.score === 4) {
    await ensureLabelExists(octokit, owner, repo);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issue.number,
      labels: [AGENT_READY_LABEL],
    });
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
