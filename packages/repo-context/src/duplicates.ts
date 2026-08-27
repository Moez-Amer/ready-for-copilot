/**
 * Words that carry no signal about what a piece of work actually is. Two
 * titles sharing only these are not the same task.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "to", "in", "for", "of", "on", "and", "or", "with", "from",
  "at", "by", "is", "be", "should", "must", "we", "its", "it", "this", "that",
  "add", "update", "change", "make", "set",
]);

/**
 * Reduce a title to the tokens that identify the work. Paths and identifiers
 * survive intact, because they are the strongest signal that two titles
 * describe the same change.
 */
export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/^[^\w./-]+|[^\w./-]+$/g, ""))
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

/**
 * How much of `candidate` is already present in `existing`, 0-1.
 *
 * Containment rather than symmetric similarity: a proposed sub-issue whose
 * every meaningful term already appears in an open issue is a duplicate, even
 * if the open issue says more besides.
 */
export function containment(candidate: string, existing: string): number {
  const candidateTokens = titleTokens(candidate);
  if (candidateTokens.size === 0) return 0;
  const existingTokens = titleTokens(existing);
  let shared = 0;
  for (const token of candidateTokens) {
    if (existingTokens.has(token)) shared += 1;
  }
  return shared / candidateTokens.size;
}

/** Above this, two titles describe the same piece of work. */
export const DUPLICATE_THRESHOLD = 0.7;

export interface ExistingIssue {
  number: number;
  title: string;
}

/**
 * The open issue that already covers this proposed title, if any.
 *
 * Asking the model not to duplicate open issues turned out not to be enough --
 * it was handed the list and re-filed one anyway -- so this check runs over
 * whatever it proposes.
 */
export function findDuplicate(
  candidate: string,
  existing: ExistingIssue[],
  threshold = DUPLICATE_THRESHOLD,
): ExistingIssue | null {
  let best: ExistingIssue | null = null;
  let bestScore = threshold;
  for (const issue of existing) {
    const score = containment(candidate, issue.title);
    if (score >= bestScore) {
      best = issue;
      bestScore = score;
    }
  }
  return best;
}
