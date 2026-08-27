import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildRepoContext } from "@issue-triage/repo-context";
import {
  CONFIDENCE_THRESHOLD,
  classifyForDelegation,
  decomposeIssue,
  MAX_SUB_ISSUES,
  scoreReadiness,
  type DelegationResult,
  type ReadinessResult,
  type SubIssue,
} from "@issue-triage/scorer";

type Octokit = ReturnType<typeof github.getOctokit>;

const TRIGGER = "/split";
const MECHANICAL_LABEL = "mechanical";
const JUDGEMENT_LABEL = "judgement";
const LABEL_SPECS = [
  {
    name: MECHANICAL_LABEL,
    color: "0e8a16",
    description: "Outcome is fully determined; handed to the coding agent.",
  },
  {
    name: JUDGEMENT_LABEL,
    color: "d93f0b",
    description: "Needs human judgement -- left unassigned to claim.",
  },
];

interface CreatedSubIssue {
  number: number;
  id: number;
  subIssue: SubIssue;
  result: DelegationResult;
  assignedToCopilot: boolean;
}

async function ensureLabels(octokit: Octokit, owner: string, repo: string): Promise<void> {
  for (const spec of LABEL_SPECS) {
    try {
      await octokit.rest.issues.getLabel({ owner, repo, name: spec.name });
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      await octokit.rest.issues.createLabel({ owner, repo, ...spec });
    }
  }
}

/**
 * Link a child as a real GitHub sub-issue so the parent gets its progress
 * rollup for free. Octokit has no typed method for this endpoint yet, so it
 * goes through raw request(). Best-effort: a failure here leaves the child as
 * a normal standalone issue, which is worse but not broken.
 */
async function linkSubIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  parentNumber: number,
  childId: number,
): Promise<void> {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      owner,
      repo,
      issue_number: parentNumber,
      sub_issue_id: childId,
    });
  } catch (err) {
    core.warning(
      `Could not link #${childId} as a sub-issue of #${parentNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Resolve the Copilot coding agent's actor id, or null if it isn't available here. */
async function findCopilotActorId(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const response = await octokit.graphql<{
      repository: { suggestedActors: { nodes: Array<{ login: string; id: string }> } };
    }>(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
            nodes { login ... on Bot { id } ... on User { id } }
          }
        }
      }`,
      { owner, repo },
    );
    const copilot = response.repository.suggestedActors.nodes.find(
      (node) => node.login === "copilot-swe-agent",
    );
    return copilot?.id ?? null;
  } catch (err) {
    core.warning(
      `Could not look up the Copilot coding agent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Assign a mechanical sub-issue to the Copilot coding agent. Copilot is not a
 * normal assignee, so this needs the replaceActorsForAssignable mutation
 * rather than the REST assignees endpoint. Returns false if the assignment
 * didn't happen, in which case the sub-issue stays unassigned for a human --
 * failing safe, rather than failing the run.
 */
async function assignToCopilot(
  octokit: Octokit,
  issueNodeId: string,
  copilotActorId: string,
  issueNumber: number,
): Promise<boolean> {
  try {
    await octokit.graphql(
      `mutation($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
          assignable { __typename }
        }
      }`,
      { assignableId: issueNodeId, actorIds: [copilotActorId] },
    );
    return true;
  } catch (err) {
    core.warning(
      `Could not assign #${issueNumber} to Copilot: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Splitting a vague or fictional issue just multiplies the problem: you get
 * vague or fictional sub-issues, and now the board is worse than before. Score
 * the parent first and decline rather than decompose something unsplittable.
 */
function refusalReason(readiness: ReadinessResult): string | null {
  if (readiness.grounded === false) {
    return [
      "I'm not splitting this one yet.",
      "",
      `⚠️ **This doesn't match the code:** ${readiness.groundingRationale}`,
      "",
      "Breaking up an issue that describes code which isn't there would just produce sub-issues carrying the same problem. Correct the references, then comment `/split` again.",
    ].join("\n");
  }
  // The scope signal asks precisely whether this is one bounded change rather
  // than several bundled together. When it passes, there are no seams to split
  // along, and decomposing anyway just clones the parent into a sub-issue.
  if (readiness.raw.scope.pass && readiness.raw.scope.confidence >= CONFIDENCE_THRESHOLD) {
    return [
      "I'm not splitting this one — it's already a single bounded change.",
      "",
      `_${readiness.raw.scope.rationale}_`,
      "",
      "Splitting it would just restate it as a sub-issue. Work it directly, or hand it to an agent if it carries the `agent-ready` label.",
    ].join("\n");
  }
  if (readiness.confident && readiness.score <= 1) {
    const suggestion = readiness.suggestion.trim();
    return [
      `I'm not splitting this one yet — it scores **${readiness.score}/4** on agent-readiness, which isn't enough to break into anything useful.`,
      "",
      suggestion,
      "",
      "Sharpen the issue, then comment `/split` again.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return null;
}

function formatSummary(created: CreatedSubIssue[], copilotAvailable: boolean): string {
  const mechanical = created.filter((c) => c.result.classification === "mechanical");
  const judgement = created.filter((c) => c.result.classification === "judgement");

  const lines = [
    `Split into ${created.length} sub-issue${created.length === 1 ? "" : "s"}.`,
    "",
    `**Mechanical (${mechanical.length})** — outcome is fully determined, so these went to the coding agent:`,
  ];
  lines.push(
    mechanical.length
      ? mechanical
          .map((c) => `- #${c.number}${c.assignedToCopilot ? "" : " _(assignment failed; unassigned)_"}`)
          .join("\n")
      : "- _none_",
  );
  lines.push("", `**Judgement (${judgement.length})** — left unassigned for a human to claim:`);
  lines.push(
    judgement.length
      ? judgement
          .map((c) => {
            const reason = !c.result.raw.blastRadius.pass
              ? c.result.raw.blastRadius.rationale
              : !c.result.raw.taskPattern.pass
                ? c.result.raw.taskPattern.rationale
                : `scored ${c.result.layerAScore}/4 on readiness`;
            return `- #${c.number}\n  _${reason}_`;
          })
          .join("\n")
      : "- _none_",
  );

  if (!copilotAvailable) {
    lines.push(
      "",
      "_The Copilot coding agent isn't available on this repository, so mechanical sub-issues were labelled but left unassigned._",
    );
  }
  lines.push(
    "",
    "Every classification is a label — flip `mechanical` / `judgement` on any sub-issue to override it.",
  );
  return lines.join("\n");
}

async function run(): Promise<void> {
  // The scorer package reads AWS_BEARER_TOKEN_BEDROCK / AWS_REGION straight
  // from the environment; bridge the action's inputs into that shape before
  // its client is constructed.
  process.env.AWS_BEARER_TOKEN_BEDROCK = core.getInput("aws-bearer-token-bedrock", { required: true });
  process.env.AWS_REGION = core.getInput("aws-region") || "us-east-1";

  const octokit = github.getOctokit(core.getInput("github-token", { required: true }));
  const { owner, repo } = github.context.repo;
  const { issue, comment } = github.context.payload;

  if (!issue || !comment) {
    core.setFailed("This action must run on an `issue_comment` event.");
    return;
  }
  if (issue.pull_request) {
    core.info("Comment is on a pull request, not an issue. Nothing to split.");
    return;
  }
  // GitHub's slash-command autocomplete fights you while typing `/split`, so
  // accept it as a standalone word anywhere in the comment rather than only at
  // the very start.
  if (!new RegExp(`(^|\\s)${TRIGGER}\\b`, "i").test(String(comment.body ?? ""))) {
    core.info(`Comment does not contain ${TRIGGER}. Nothing to do.`);
    return;
  }

  const title = issue.title ?? "";
  const body = issue.body ?? "";

  // Read what this repository actually contains, once. Decompose uses it to
  // split along real seams instead of guessing at structure, and classify uses
  // it to judge blast radius against real files rather than filenames.
  const repoContext = await buildRepoContext({
    octokit,
    owner,
    repo,
    issueText: `${title}\n${body}`,
  });
  if (!repoContext) {
    core.warning("Could not read repository context; splitting on issue text alone.");
  }
  const context = repoContext ?? undefined;

  // Gate before decomposing -- see refusalReason.
  const refusal = refusalReason(await scoreReadiness({ title, body, repoContext: context }));
  if (refusal) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: refusal,
    });
    core.info("Declined to split: parent issue isn't ready.");
    return;
  }

  // Pass 1 -- decompose. Token-heaviest call in the pipeline.
  const subIssues = await decomposeIssue({ title, body, repoContext: context });
  // One sub-issue is a copy of the parent, not a split. Refuse rather than
  // leave behind a duplicate that has to be closed by hand.
  if (subIssues.length < 2) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: "I couldn't find a sensible way to split this issue — it looks like a single piece of work already, so splitting it would just restate it. Work it directly.",
    });
    return;
  }
  core.info(`Decomposed into ${subIssues.length} sub-issues (cap ${MAX_SUB_ISSUES}).`);

  await ensureLabels(octokit, owner, repo);
  const copilotActorId = await findCopilotActorId(octokit, owner, repo);

  const created: CreatedSubIssue[] = [];
  for (const subIssue of subIssues) {
    const { data } = await octokit.rest.issues.create({
      owner,
      repo,
      title: subIssue.title,
      body: `${subIssue.body}\n\n---\nSplit from #${issue.number}.`,
    });
    await linkSubIssue(octokit, owner, repo, issue.number, data.id);

    // Pass 2 -- classify. The riskiest step: a wrong "mechanical" here ships
    // an unreviewed PR, so deriveDelegationResult defaults to judgement on
    // any doubt.
    const result = await classifyForDelegation({ ...subIssue, repoContext: context });

    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: data.number,
      labels: [result.classification],
    });

    // Pass 3 -- delegate. Mechanical goes to the agent; judgement stays
    // unassigned for a human to claim.
    let assignedToCopilot = false;
    if (result.classification === "mechanical" && copilotActorId) {
      assignedToCopilot = await assignToCopilot(
        octokit,
        data.node_id,
        copilotActorId,
        data.number,
      );
    }

    created.push({
      number: data.number,
      id: data.id,
      subIssue,
      result,
      assignedToCopilot,
    });
    core.info(`#${data.number} ${result.classification} — ${subIssue.title}`);
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body: formatSummary(created, copilotActorId !== null),
  });
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
