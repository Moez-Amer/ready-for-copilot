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
  body?: string | null | undefined;
}

/**
 * A body restates far more incidental vocabulary than a title does -- two
 * unrelated issues touching one file share plenty of words -- so a body match
 * only counts alongside a partial title match, and needs a higher bar.
 */
export const BODY_THRESHOLD = 0.6;
/** Enough title overlap to let a moderate body match confirm a duplicate. */
export const PARTIAL_TITLE_THRESHOLD = 0.45;
/**
 * A body this close is decisive on its own. The same task filed twice often
 * carries two unrelated titles, so requiring the titles to agree first would
 * miss exactly the duplicates worth catching.
 */
export const BODY_ALONE_THRESHOLD = 0.75;

export interface DuplicateCandidate {
  title: string;
  body?: string | null | undefined;
}

/**
 * The open issue that already covers this proposed work, if any.
 *
 * Matches on title, and on body where the titles already partly agree: the
 * same task filed under two different titles is still the same task, but body
 * overlap on its own is too noisy to trust.
 *
 * Asking the model not to duplicate open issues turned out not to be enough --
 * it was handed the list and re-filed one anyway -- so this check runs over
 * whatever it proposes.
 */
export function findDuplicate(
  candidate: string | DuplicateCandidate,
  existing: ExistingIssue[],
  threshold = DUPLICATE_THRESHOLD,
): ExistingIssue | null {
  const proposed: DuplicateCandidate =
    typeof candidate === "string" ? { title: candidate } : candidate;

  let best: ExistingIssue | null = null;
  let bestScore = 0;

  for (const issue of existing) {
    const titleScore = containment(proposed.title, issue.title);

    let score = titleScore >= threshold ? titleScore : 0;
    if (!score && proposed.body && issue.body) {
      const bodyScore = containment(proposed.body, issue.body);
      if (bodyScore >= BODY_ALONE_THRESHOLD) {
        score = bodyScore;
      } else if (titleScore >= PARTIAL_TITLE_THRESHOLD && bodyScore >= BODY_THRESHOLD) {
        score = (titleScore + bodyScore) / 2;
      }
    }

    if (score > bestScore) {
      best = issue;
      bestScore = score;
    }
  }
  return best;
}
