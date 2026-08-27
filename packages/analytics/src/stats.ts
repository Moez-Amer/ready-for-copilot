/** The labels this tool applies, in the order a reader should meet them. */
export const TRACKED_LABELS = [
  "agent-ready",
  "mechanical",
  "needs-human",
  "judgement",
  "needs-detail",
  "not-in-codebase",
  "not-a-task",
] as const;

export type TrackedLabel = (typeof TRACKED_LABELS)[number];

export interface AnalysedIssue {
  number: number;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
}

export interface LabelStat {
  label: TrackedLabel;
  total: number;
  closed: number;
  /** Median hours from opening to closing, over closed issues only. */
  medianHoursToClose: number | null;
}

export interface Summary {
  /** Issues carrying at least one label this tool applies. */
  scored: number;
  /** Issues with none of them -- opened before adoption, or still unscored. */
  untracked: number;
  labels: LabelStat[];
  /** Of the work routed by /split, the share safe to delegate. */
  mechanicalShare: number | null;
  generatedAt: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function hoursToClose(issue: AnalysedIssue): number | null {
  if (!issue.closedAt) return null;
  const ms = new Date(issue.closedAt).getTime() - new Date(issue.createdAt).getTime();
  return ms >= 0 ? ms / 3_600_000 : null;
}

/**
 * Summarise what the tool has actually done to a repository's issues.
 *
 * The headline question the original proposal asked is whether issues scoring
 * 4/4 really do get resolved faster. That is answered here by comparing median
 * time-to-close across labels -- and if they do not, the rubric is wrong,
 * which is a more interesting finding than the tool.
 */
export function summarise(issues: AnalysedIssue[], now = new Date()): Summary {
  const tracked = new Set<string>(TRACKED_LABELS);
  const scoredIssues = issues.filter((i) => i.labels.some((l) => tracked.has(l)));

  const labels: LabelStat[] = TRACKED_LABELS.map((label) => {
    const matching = issues.filter((i) => i.labels.includes(label));
    const closed = matching.filter((i) => i.closedAt !== null);
    const durations = closed
      .map(hoursToClose)
      .filter((h): h is number => h !== null);
    return {
      label,
      total: matching.length,
      closed: closed.length,
      medianHoursToClose: median(durations),
    };
  });

  const mechanical = labels.find((l) => l.label === "mechanical")?.total ?? 0;
  const judgement = labels.find((l) => l.label === "judgement")?.total ?? 0;
  const routed = mechanical + judgement;

  return {
    scored: scoredIssues.length,
    untracked: issues.length - scoredIssues.length,
    labels,
    mechanicalShare: routed > 0 ? mechanical / routed : null,
    generatedAt: now.toISOString(),
  };
}

/** "3h", "2d", "—" -- durations a reader can compare at a glance. */
export function formatDuration(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
