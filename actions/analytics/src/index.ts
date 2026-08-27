import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { renderReport, summarise, type AnalysedIssue } from "@issue-triage/analytics";

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

  const summary = summarise(issues);
  const html = renderReport(summary, `${owner}/${repo}`);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, "utf8");

  core.info(`Wrote ${output}: ${summary.scored} triaged, ${summary.untracked} untracked.`);
  core.setOutput("path", output);
  core.setOutput("scored", String(summary.scored));
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
