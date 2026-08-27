#!/usr/bin/env node
// Generate the triage report locally, without deploying anything.
//   npm run report -- owner/repo
// Requires the gh CLI, authenticated.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarise, renderReport } from "../packages/analytics/dist/index.js";

const repo = process.argv[2];
if (!repo || !repo.includes("/")) {
  console.error("Usage: npm run report -- owner/repo");
  process.exit(1);
}

const out = resolve(process.argv[3] ?? "triage-report.html");

let raw;
try {
  raw = execFileSync(
    "gh",
    ["api", "--paginate", `repos/${repo}/issues?state=all&per_page=100`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch {
  console.error(`Could not read issues from ${repo}. Is the gh CLI authenticated, and do you have access?`);
  process.exit(1);
}

// --paginate concatenates one JSON array per page.
const issues = raw
  .replace(/\]\s*\[/g, ",")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return [];
    }
  })
  .filter((i) => !i.pull_request)
  .map((i) => ({
    number: i.number,
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
    createdAt: i.created_at,
    closedAt: i.closed_at,
  }));

const summary = summarise(issues);
writeFileSync(out, renderReport(summary, repo), "utf8");
console.log(`${issues.length} issues -> ${summary.scored} triaged, ${summary.untracked} untriaged`);
console.log(`Wrote ${out}`);
