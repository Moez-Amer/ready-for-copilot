import { describe, expect, it } from "vitest";
import { containment, findDuplicate, titleTokens } from "./duplicates.js";

// The pair that actually slipped through in testing: /split re-filed work an
// open issue already covered, despite being shown that issue.
const OPEN = [
  { number: 28, title: "Add timeout-minutes to the score job in .github/workflows/issue-readiness.yml" },
  { number: 30, title: "Add a stale-issue workflow at .github/workflows/stale.yml" },
];

describe("titleTokens", () => {
  it("keeps paths intact, since they identify the work", () => {
    expect(titleTokens("Add timeout to .github/workflows/a.yml")).toContain(".github/workflows/a.yml");
  });

  it("drops filler words that carry no signal", () => {
    const tokens = titleTokens("Add the timeout to the job");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("add")).toBe(false);
    expect(tokens.has("timeout")).toBe(true);
  });
});

describe("findDuplicate", () => {
  it("catches the real-world duplicate that got through", () => {
    const found = findDuplicate(
      "Add timeout-minutes: 10 to the score job in .github/workflows/issue-readiness.yml",
      OPEN,
    );
    expect(found?.number).toBe(28);
  });

  it("does not flag different work on the same file", () => {
    const found = findDuplicate(
      "Add concurrency group keyed on issue number to .github/workflows/issue-readiness.yml",
      OPEN,
    );
    expect(found).toBeNull();
  });

  it("does not flag the same change to a different file", () => {
    const found = findDuplicate(
      "Add timeout-minutes: 10 to the split job in .github/workflows/issue-split.yml",
      OPEN,
    );
    expect(found).toBeNull();
  });

  it("returns null when nothing is open", () => {
    expect(findDuplicate("Anything at all", [])).toBeNull();
  });

  it("scores an exact restatement as fully contained", () => {
    expect(containment(OPEN[0]!.title, OPEN[0]!.title)).toBe(1);
  });
});

describe("findDuplicate with bodies", () => {
  const open = [
    {
      number: 12,
      title: "Guard the split job against overlapping runs",
      body: "Add a concurrency group keyed on the issue number to the split job in .github/workflows/issue-split.yml so two rapid comments cannot race.",
    },
  ];

  it("catches the same work filed under a different title", () => {
    const found = findDuplicate(
      {
        title: "Add concurrency group to .github/workflows/issue-split.yml",
        body: "Add a concurrency group keyed on the issue number to the split job in .github/workflows/issue-split.yml so two rapid comments cannot race.",
      },
      open,
    );
    expect(found?.number).toBe(12);
  });

  it("does not match different work that merely touches the same file", () => {
    const found = findDuplicate(
      {
        title: "Add timeout-minutes to the split job",
        body: "Add `timeout-minutes: 10` to the split job in .github/workflows/issue-split.yml, directly below its runs-on line. Done when the file contains that setting.",
      },
      open,
    );
    expect(found).toBeNull();
  });

  it("still works when no bodies are available", () => {
    const found = findDuplicate(
      { title: "Guard the split job against overlapping runs" },
      [{ number: 12, title: "Guard the split job against overlapping runs" }],
    );
    expect(found?.number).toBe(12);
  });
});
