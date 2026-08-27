/** Things an issue can claim about a repo, which we can then go verify. */
export interface ExtractedClaims {
  /** Path-like strings: src/models/user.py, migrations/, tests/fixtures/ */
  paths: string[];
  /** Code identifiers: getUser, email_addr, UserSerializer */
  symbols: string[];
}

const PATH_PATTERN = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]*)/g;
const BACKTICKED = /`([^`\n]{2,80})`/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Words that look like identifiers but are almost always prose, not code.
const PROSE = new Set([
  "the", "this", "that", "when", "then", "should", "would", "could", "will",
  "and", "but", "for", "with", "from", "into", "onto", "user", "users", "issue",
  "bug", "fix", "add", "update", "remove", "change", "make", "new", "old",
  "todo", "note", "done", "expected", "actual", "steps", "reproduce",
]);

function looksLikeCode(token: string): boolean {
  if (!IDENTIFIER.test(token)) return false;
  if (PROSE.has(token.toLowerCase())) return false;
  // camelCase, snake_case, PascalCase, or SCREAMING_CASE -- prose rarely is.
  return /[a-z][A-Z]/.test(token) || token.includes("_") || /^[A-Z]/.test(token);
}

/**
 * Pull out the concrete, checkable claims an issue makes about the codebase.
 * Deliberately conservative: a false positive costs a wasted search, but a
 * false negative means we silently fail to verify something.
 */
export function extractClaims(text: string, limits = { paths: 8, symbols: 6 }): ExtractedClaims {
  const paths = new Set<string>();
  const symbols = new Set<string>();

  for (const match of text.matchAll(PATH_PATTERN)) {
    const candidate = match[1]?.replace(/[.,;:)]+$/, "");
    if (candidate && candidate.length > 2 && !candidate.startsWith("http")) {
      paths.add(candidate);
    }
  }

  // Backticked spans are the strongest signal an author meant "this is code".
  for (const match of text.matchAll(BACKTICKED)) {
    const inner = match[1]?.trim() ?? "";
    if (inner.includes("/")) {
      paths.add(inner.replace(/[.,;:)]+$/, ""));
    } else {
      const bare = inner.replace(/\(\)$/, "");
      if (IDENTIFIER.test(bare) && !PROSE.has(bare.toLowerCase())) symbols.add(bare);
    }
  }

  for (const token of text.split(/[^\w$]+/)) {
    if (looksLikeCode(token)) symbols.add(token);
  }

  return {
    paths: [...paths].slice(0, limits.paths),
    symbols: [...symbols].slice(0, limits.symbols),
  };
}
