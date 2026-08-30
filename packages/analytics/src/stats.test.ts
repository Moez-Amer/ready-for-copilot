import { describe, expect, it } from "vitest";
import { buildTrend, formatDuration, measureFeedback, summarise, type AnalysedIssue } from "./stats.js";

const H = 3_600_000;
const base = new Date("2026-01-01T00:00:00Z").getTime();
function issue(n: number, labels: string[], openHours: number | null): AnalysedIssue {
  return {
    number: n,
    labels,
    createdAt: new Date(base).toISOString(),
    closedAt: openHours === null ? null : new Date(base + openHours * H).toISOString(),
  };
}

describe("summarise", () => {
  it("separates scored issues from ones the tool never saw", () => {
    const s = summarise([issue(1, ["agent-ready"], 2), issue(2, [], null), issue(3, ["bug"], null)]);
    expect(s.scored).toBe(1);
    expect(s.untracked).toBe(2);
  });

  it("takes the median time to close, not the mean, so one stale issue cannot skew it", () => {
    const s = summarise([
      issue(1, ["agent-ready"], 1),
      issue(2, ["agent-ready"], 3),
      issue(3, ["agent-ready"], 1000),
    ]);
    expect(s.labels.find((l) => l.label === "agent-ready")?.medianHoursToClose).toBe(3);
  });

  it("ignores still-open issues when timing closures", () => {
    const s = summarise([issue(1, ["needs-detail"], 10), issue(2, ["needs-detail"], null)]);
    const stat = s.labels.find((l) => l.label === "needs-detail");
    expect(stat?.total).toBe(2);
    expect(stat?.closed).toBe(1);
    expect(stat?.medianHoursToClose).toBe(10);
  });

  it("reports the delegatable share of split work", () => {
    const s = summarise([
      issue(1, ["mechanical"], null),
      issue(2, ["mechanical"], null),
      issue(3, ["mechanical"], null),
      issue(4, ["judgement"], null),
    ]);
    expect(s.mechanicalShare).toBe(0.75);
  });

  it("reports no share rather than zero when nothing has been split", () => {
    expect(summarise([issue(1, ["agent-ready"], null)]).mechanicalShare).toBeNull();
  });

  it("reports no median rather than zero when nothing has closed", () => {
    expect(summarise([issue(1, ["agent-ready"], null)]).labels[0]?.medianHoursToClose).toBeNull();
  });
});

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(0.5)).toBe("30m");
    expect(formatDuration(5)).toBe("5h");
    expect(formatDuration(72)).toBe("3d");
  });
  it("shows a dash when there is nothing to report", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("measureFeedback", () => {
  const at = (h: number) => new Date(base + h * H).toISOString();

  it("counts an issue that was flagged and later reached ready", () => {
    const f = measureFeedback([
      {
        ...issue(1, ["agent-ready"], null),
        history: [
          { label: "needs-detail", action: "labeled", at: at(0) },
          { label: "needs-detail", action: "unlabeled", at: at(5) },
          { label: "agent-ready", action: "labeled", at: at(5) },
        ],
      },
    ]);
    expect(f.flagged).toBe(1);
    expect(f.improved).toBe(1);
    expect(f.medianHoursToImprove).toBe(5);
  });

  it("counts an issue still sitting flagged", () => {
    const f = measureFeedback([
      {
        ...issue(2, ["needs-detail"], null),
        history: [{ label: "needs-detail", action: "labeled", at: at(0) }],
      },
    ]);
    expect(f.flagged).toBe(1);
    expect(f.improved).toBe(0);
  });

  it("ignores issues that were ready from the start", () => {
    const f = measureFeedback([
      {
        ...issue(3, ["agent-ready"], null),
        history: [{ label: "agent-ready", action: "labeled", at: at(0) }],
      },
    ]);
    expect(f.flagged).toBe(0);
  });

  it("does not count a flag applied after the issue was already ready", () => {
    const f = measureFeedback([
      {
        ...issue(4, ["needs-detail"], null),
        history: [
          { label: "agent-ready", action: "labeled", at: at(0) },
          { label: "needs-detail", action: "labeled", at: at(9) },
        ],
      },
    ]);
    expect(f.flagged).toBe(1);
    expect(f.improved).toBe(0);
  });

  it("reports that it could not measure when no history was fetched", () => {
    expect(measureFeedback([issue(5, ["agent-ready"], null)]).measured).toBe(false);
  });
});

describe("buildTrend", () => {
  it("groups issues by the week they were opened", () => {
    const t = buildTrend([
      issue(1, ["agent-ready"], null),
      issue(2, ["needs-detail"], null),
      { ...issue(3, ["mechanical"], null), createdAt: new Date(base + 8 * 24 * H).toISOString() },
    ]);
    expect(t).toHaveLength(2);
    expect(t[0]?.opened).toBe(2);
    expect(t[0]?.ready).toBe(1);
    expect(t[1]?.ready).toBe(1);
  });
});
