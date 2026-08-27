import type * as github from "@actions/github";
import { extractClaims } from "./symbols.js";

export { extractClaims } from "./symbols.js";
export type { ExtractedClaims } from "./symbols.js";

type Octokit = ReturnType<typeof github.getOctokit>;

/** Build artefacts and binaries tell the model nothing about the codebase. */
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|vendor|coverage|\.git|\.next|target|__pycache__)(\/|$)/;
const SKIP_FILE = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|mov|zip|gz|pdf|lock|map|min\.js|min\.css)$/i;

/** Above this, the full listing stops being useful context and starts being noise. */
const MAX_LISTED_FILES = 300;
/** GitHub's code search endpoint is rate-limited far more tightly than the rest of the API. */
const MAX_SEARCHES = 6;

interface TreeEntry {
  path?: string;
  type?: string;
}

function isInteresting(path: string): boolean {
  return !SKIP_DIR.test(path) && !SKIP_FILE.test(path);
}

/**
 * When a repo is too big to list file-by-file, a per-directory count still
 * tells the model what exists and roughly how much of it -- enough to judge
 * whether "the settings page" corresponds to anything real.
 */
function summariseByDirectory(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120)
    .map(([dir, count]) => `${dir}/ (${count} files)`)
    .join("\n");
}

async function listRepoFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string[] | null> {
  try {
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const { data: tree } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: repoData.default_branch,
      recursive: "1",
    });
    return (tree.tree as TreeEntry[])
      .filter((entry) => entry.type === "blob" && entry.path && isInteresting(entry.path))
      .map((entry) => entry.path as string);
  } catch {
    return null;
  }
}

async function symbolExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  symbol: string,
): Promise<boolean | null> {
  try {
    const { data } = await octokit.rest.search.code({
      q: `${symbol} repo:${owner}/${repo}`,
      per_page: 1,
    });
    return data.total_count > 0;
  } catch {
    // Search is unavailable on unindexed repos and heavily rate-limited.
    // Unknown is very different from "not found" -- never conflate them.
    return null;
  }
}

export interface RepoContextOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  issueText: string;
}

/**
 * Assemble what this repository actually contains, so the scorer can tell a
 * well-written issue from a well-written *fictional* issue.
 *
 * Everything degrades to null rather than throwing: grounding is an
 * enhancement to scoring, and must never be the reason an issue goes
 * unscored.
 */
export async function buildRepoContext({
  octokit,
  owner,
  repo,
  issueText,
}: RepoContextOptions): Promise<string | null> {
  const files = await listRepoFiles(octokit, owner, repo);
  if (!files) return null;

  const sections: string[] = [];

  sections.push(
    files.length <= MAX_LISTED_FILES
      ? `## Files in this repository (${files.length})\n${files.join("\n")}`
      : `## Directories in this repository (${files.length} files total, listed by directory)\n${summariseByDirectory(files)}`,
  );

  const claims = extractClaims(issueText);

  if (claims.paths.length > 0) {
    const fileSet = new Set(files);
    const lines = claims.paths.map((claimed) => {
      const normalised = claimed.replace(/\/$/, "");
      const exact = fileSet.has(claimed) || fileSet.has(normalised);
      const asDirectory = files.some((file) => file.startsWith(`${normalised}/`));
      return exact || asDirectory
        ? `- \`${claimed}\` — EXISTS`
        : `- \`${claimed}\` — NOT FOUND in this repository`;
    });
    sections.push(`## Paths this issue names\n${lines.join("\n")}`);
  }

  if (claims.symbols.length > 0) {
    const results = await Promise.all(
      claims.symbols.slice(0, MAX_SEARCHES).map(async (symbol) => {
        const found = await symbolExists(octokit, owner, repo, symbol);
        if (found === null) return `- \`${symbol}\` — could not verify (code search unavailable)`;
        return found
          ? `- \`${symbol}\` — found in this repository`
          : `- \`${symbol}\` — NOT FOUND in this repository`;
      }),
    );
    sections.push(`## Symbols this issue names\n${results.join("\n")}`);
  }

  return sections.join("\n\n");
}
