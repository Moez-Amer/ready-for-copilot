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

export interface LabelEvent {
  label: string;
  action: "labeled" | "unlabeled";
  at: string;
}

export interface AnalysedIssue {
  number: number;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
  /** Label changes over time, when available. Absent means not fetched. */
  history?: LabelEvent[];
}

/** Labels meaning "this issue is not ready as written". */
const NOT_READY = new Set(["needs-detail", "not-in-codebase"]);

export interface FeedbackEffect {
  /** Issues that were flagged as not ready at some point. */
  flagged: number;
  /** Of those, how many later reached agent-ready. */
  improved: number;
  /** Median hours from first flag to reaching agent-ready. */
  medianHoursToImprove: number | null;
  /** Whether label history was available at all. */
  measured: boolean;
}

export interface TrendBucket {
  /** ISO date of the week's Monday. */
  week: string;
  opened: number;
  ready: number;
}

export interface LabelStat {
  label: TrackedLabel;
  total: number;
  closed: number;
  /** Median hours from opening to closing, over closed issues only. */
  medianHoursToClose: number | null;
}

export interface Summary {
  /** Whether issues the tool flagged actually got fixed. */
  feedback: FeedbackEffect;
  /** Issues opened per week, and how many reached agent-ready. */
  trend: TrendBucket[];
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

/**
 * Whether the tool's feedback actually changes anything.
 *
 * The premise of the Linter is that telling an author what is missing gets
 * the issue fixed. That is a claim about behaviour, and it is measurable:
 * count the issues it flagged, then count how many later reached
 * agent-ready. If almost none do, the comments are decoration.
 */
export function measureFeedback(issues: AnalysedIssue[]): FeedbackEffect {
  const withHistory = issues.filter((i) => i.history && i.history.length > 0);
  if (withHistory.length === 0) {
    return { flagged: 0, improved: 0, medianHoursToImprove: null, measured: false };
  }

  let flagged = 0;
  let improved = 0;
  const durations: number[] = [];

  for (const issue of withHistory) {
    const events = [...issue.history!].sort((a, b) => a.at.localeCompare(b.at));
    const firstFlag = events.find((e) => e.action === "labeled" && NOT_READY.has(e.label));
    if (!firstFlag) continue;
    flagged += 1;

    const becameReady = events.find(
      (e) => e.action === "labeled" && e.label === "agent-ready" && e.at > firstFlag.at,
    );
    if (becameReady) {
      improved += 1;
      durations.push(
        (new Date(becameReady.at).getTime() - new Date(firstFlag.at).getTime()) / 3_600_000,
      );
    }
  }

  return { flagged, improved, medianHoursToImprove: median(durations), measured: true };
}

/** Monday of the week containing this date, as an ISO date. */
function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Issues opened per week, and how many of them reached agent-ready. */
export function buildTrend(issues: AnalysedIssue[], weeks = 8): TrendBucket[] {
  const buckets = new Map<string, TrendBucket>();
  for (const issue of issues) {
    const week = weekStart(issue.createdAt);
    const bucket = buckets.get(week) ?? { week, opened: 0, ready: 0 };
    bucket.opened += 1;
    if (issue.labels.includes("agent-ready") || issue.labels.includes("mechanical")) {
      bucket.ready += 1;
    }
    buckets.set(week, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-weeks);
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
    feedback: measureFeedback(issues),
    trend: buildTrend(issues),
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
