import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  classifyForDelegation,
  decomposeIssue,
  MAX_SUB_ISSUES,
  type DelegationResult,
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
          .map(
            (c) =>
              `- #${c.number} — ${c.subIssue.title}${
                c.assignedToCopilot ? "" : " _(assignment failed; unassigned)_"
              }`,
          )
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
            return `- #${c.number} — ${c.subIssue.title}\n  _${reason}_`;
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
  if (!String(comment.body ?? "").trim().toLowerCase().startsWith(TRIGGER)) {
    core.info(`Comment does not start with ${TRIGGER}. Nothing to do.`);
    return;
  }

  // Pass 1 -- decompose. Token-heaviest call in the pipeline.
  const subIssues = await decomposeIssue({
    title: issue.title ?? "",
    body: issue.body ?? "",
  });
  if (subIssues.length === 0) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: "I couldn't find a sensible way to split this issue. It may already be small enough to work on directly.",
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
    const result = await classifyForDelegation(subIssue);

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
