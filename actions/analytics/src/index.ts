import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { renderReport, summarise, type AnalysedIssue, type LabelEvent } from "@issue-triage/analytics";

async function run(): Promise<void> {
  const octokit = github.getOctokit(core.getInput("github-token", { required: true }));
  const { owner, repo } = github.context.repo;
  const output = core.getInput("output") || "public/index.html";

  // Every issue, open and closed -- time-to-close is the whole point, and that
  // only exists on closed ones.
  const issues: AnalysedIssue[] = [];
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  })) {
    for (const issue of page.data) {
      if (issue.pull_request) continue;
      issues.push({
        number: issue.number,
        labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
        createdAt: issue.created_at,
        closedAt: issue.closed_at,
      });
    }
  }

  // Label history is what makes the feedback effect measurable: an issue
  // flagged and later marked ready is the tool working. One request per issue,
  // so it is capped and degrades to no history rather than failing.
  const HISTORY_LIMIT = 300;
  for (const issue of issues.slice(0, HISTORY_LIMIT)) {
    try {
      const { data } = await octokit.rest.issues.listEvents({
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      });
      const history: LabelEvent[] = [];
      for (const event of data) {
        if (event.event !== "labeled" && event.event !== "unlabeled") continue;
        const label = (event as { label?: { name?: string } }).label?.name;
        if (label) history.push({ label, action: event.event, at: event.created_at });
      }
      issue.history = history;
    } catch {
      // Leave history absent; the report says the effect could not be measured.
    }
  }

  const summary = summarise(issues);
  const html = renderReport(summary, `${owner}/${repo}`);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, "utf8");

  core.info(`Wrote ${output}: ${summary.scored} scored, ${summary.untracked} unscored.`);
  core.setOutput("path", output);
  core.setOutput("scored", String(summary.scored));
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
