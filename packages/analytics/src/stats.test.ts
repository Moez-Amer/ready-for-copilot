import { describe, expect, it } from "vitest";
import { formatDuration, summarise, type AnalysedIssue } from "./stats.js";

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
  it("separates triaged issues from ones the tool never saw", () => {
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
