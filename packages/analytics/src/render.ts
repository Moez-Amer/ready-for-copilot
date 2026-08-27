import { formatDuration, type Summary, type LabelStat, type FeedbackEffect, type TrendBucket } from "./stats.js";

/** Each label's meaning and hue, so the page reads without a legend. */
const LABEL_META: Record<string, { hue: string; blurb: string }> = {
  "agent-ready": { hue: "#1a7f37", blurb: "Well specified, real, and safe to delegate" },
  mechanical: { hue: "#1a7f37", blurb: "Sub-issue routed to the coding agent" },
  "needs-human": { hue: "#8250df", blurb: "Well specified, but touches something sensitive" },
  judgement: { hue: "#8250df", blurb: "Sub-issue kept for a human" },
  "needs-detail": { hue: "#9a6700", blurb: "Scored below 4/4" },
  "not-in-codebase": { hue: "#cf222e", blurb: "Describes code that isn't there" },
  "not-a-task": { hue: "#0969da", blurb: "A question or discussion, not work" },
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function bar(stat: LabelStat, max: number): string {
  const meta = LABEL_META[stat.label] ?? { hue: "#57606a", blurb: "" };
  const width = max > 0 ? Math.max((stat.total / max) * 100, stat.total > 0 ? 2 : 0) : 0;
  return `
      <tr>
        <th scope="row">
          <span class="chip" style="--hue:${meta.hue}">${escapeHtml(stat.label)}</span>
          <span class="blurb">${escapeHtml(meta.blurb)}</span>
        </th>
        <td class="num">${stat.total}</td>
        <td class="track"><span class="fill" style="width:${width.toFixed(1)}%;--hue:${meta.hue}"></span></td>
        <td class="num">${stat.closed}</td>
        <td class="num">${formatDuration(stat.medianHoursToClose)}</td>
      </tr>`;
}

/**
 * The finding worth leading with: whether issues the tool called ready
 * actually resolve faster than the ones it flagged.
 */
function verdict(summary: Summary): string {
  const ready = summary.labels.find((l) => l.label === "agent-ready");
  const detail = summary.labels.find((l) => l.label === "needs-detail");

  if (!ready?.medianHoursToClose || !detail?.medianHoursToClose) {
    return `<p class="verdict pending">Not enough closed issues yet to tell whether the rubric predicts anything. It needs issues closed on both sides — currently ${ready?.closed ?? 0} closed as <code>agent-ready</code> and ${detail?.closed ?? 0} as <code>needs-detail</code>.</p>`;
  }

  const faster = ready.medianHoursToClose < detail.medianHoursToClose;
  const ratio = faster
    ? detail.medianHoursToClose / ready.medianHoursToClose
    : ready.medianHoursToClose / detail.medianHoursToClose;

  return faster
    ? `<p class="verdict good">Issues scored <strong>agent-ready</strong> close about <strong>${ratio.toFixed(1)}× faster</strong> than those needing detail — ${formatDuration(ready.medianHoursToClose)} against ${formatDuration(detail.medianHoursToClose)}. The rubric is predicting something real.</p>`
    : `<p class="verdict bad">Issues scored <strong>agent-ready</strong> are closing <strong>${ratio.toFixed(1)}× slower</strong> than those needing detail — ${formatDuration(ready.medianHoursToClose)} against ${formatDuration(detail.medianHoursToClose)}. The rubric is not predicting what it claims to, which is worth more attention than the tool itself.</p>`;
}

/**
 * Whether telling an author what is missing actually gets the issue fixed.
 * The Linter's entire premise, stated as a number.
 */
function feedbackPanel(f: FeedbackEffect): string {
  if (!f.measured) {
    return `<p class="note">Label history wasn't available, so there's no way to tell whether flagged issues got fixed.</p>`;
  }
  if (f.flagged === 0) {
    return `<p class="note">Nothing has been flagged as needing work yet, so there's nothing to follow up on.</p>`;
  }
  const pct = Math.round((f.improved / f.flagged) * 100);
  const timing = f.medianHoursToImprove !== null
    ? ` Typically within <strong>${formatDuration(f.medianHoursToImprove)}</strong> of being flagged.`
    : "";
  return `
    <div class="funnel">
      <div class="stage"><div class="big">${f.flagged}</div><div class="cap">flagged as not ready</div></div>
      <div class="arrow" aria-hidden="true">→</div>
      <div class="stage"><div class="big">${f.improved}</div><div class="cap">later reached agent-ready</div></div>
      <div class="stage pct"><div class="big">${pct}%</div><div class="cap">acted on the feedback</div></div>
    </div>
    <p class="note">${
      pct >= 50
        ? `Most flagged issues get fixed, so the comments are changing behaviour.${timing}`
        : `Most flagged issues are still sitting unfixed. Either the feedback isn't landing, or nobody is coming back to it.${timing}`
    }</p>`;
}

/** Issues opened per week, and how many of them ended up delegatable. */
function trendChart(buckets: TrendBucket[]): string {
  if (buckets.length < 2) {
    return `<p class="note">Not enough weeks of history yet to show a trend.</p>`;
  }
  const max = Math.max(...buckets.map((b) => b.opened), 1);
  const w = 100 / buckets.length;
  const bars = buckets
    .map((b, i) => {
      const h = (b.opened / max) * 100;
      const readyH = (b.ready / max) * 100;
      const x = i * w;
      return `
        <g>
          <rect x="${(x + w * 0.2).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(w * 0.6).toFixed(2)}" height="${h.toFixed(2)}" fill="var(--line)" rx="0.6"></rect>
          <rect x="${(x + w * 0.2).toFixed(2)}" y="${(100 - readyH).toFixed(2)}" width="${(w * 0.6).toFixed(2)}" height="${readyH.toFixed(2)}" fill="#1a7f37" rx="0.6"></rect>
        </g>`;
    })
    .join("");
  const labels = buckets
    .map((b) => `<span>${escapeHtml(b.week.slice(5))}</span>`)
    .join("");
  return `
    <div class="chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Issues opened per week, with the delegatable share highlighted">${bars}</svg>
      <div class="xaxis">${labels}</div>
      <p class="note"><span class="key ready"></span> reached agent-ready &nbsp; <span class="key all"></span> opened</p>
    </div>`;
}

export function renderReport(summary: Summary, repo: string): string {
  const max = Math.max(...summary.labels.map((l) => l.total), 1);
  const share = summary.mechanicalShare;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Issue readiness — ${escapeHtml(repo)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1f2328; --muted: #59636e;
    --line: #d1d9e0; --panel: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --panel: #151b23; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  main { max-width: 62rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .3rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 2.5rem; font-size: .95rem; }
  h2 { font-size: 1.05rem; margin: 2.75rem 0 .9rem; }
  .verdict {
    border: 1px solid var(--line); border-left-width: 4px; border-radius: 6px;
    padding: 1rem 1.15rem; margin: 0; background: var(--panel);
  }
  .verdict.good { border-left-color: #1a7f37; }
  .verdict.bad { border-left-color: #cf222e; }
  .verdict.pending { border-left-color: var(--muted); }
  .cards { display: grid; gap: .85rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); margin-top: 1.25rem; }
  .card { border: 1px solid var(--line); border-radius: 6px; padding: .9rem 1rem; background: var(--panel); }
  .card .big { font-size: 1.85rem; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .card .cap { color: var(--muted); font-size: .82rem; }
  table { width: 100%; border-collapse: collapse; font-size: .93rem; }
  th, td { text-align: left; padding: .6rem .5rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  thead th { color: var(--muted); font-weight: 500; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  tbody th { font-weight: 400; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .track { width: 34%; min-width: 6rem; }
  .fill { display: block; height: .55rem; border-radius: 999px; background: var(--hue); min-width: 2px; }
  .chip {
    display: inline-block; padding: .08rem .5rem; border-radius: 999px;
    font-size: .8rem; color: #fff; background: var(--hue); white-space: nowrap;
  }
  .blurb { display: block; color: var(--muted); font-size: .8rem; margin-top: .25rem; }
  footer { margin-top: 3rem; color: var(--muted); font-size: .82rem; }
  code { background: var(--panel); padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  .wrap { overflow-x: auto; }
  .note { color: var(--muted); font-size: .87rem; margin: .9rem 0 0; }
  .funnel { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-top: 1.1rem; }
  .stage { border: 1px solid var(--line); border-radius: 6px; padding: .8rem 1.1rem; background: var(--panel); min-width: 8.5rem; }
  .stage .big { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stage .cap { color: var(--muted); font-size: .8rem; }
  .stage.pct { margin-left: auto; }
  .arrow { color: var(--muted); font-size: 1.2rem; }
  .chart { margin-top: 1.1rem; }
  .chart svg { width: 100%; height: 8rem; display: block; }
  .xaxis { display: flex; margin-top: .35rem; color: var(--muted); font-size: .72rem; }
  .xaxis span { flex: 1; text-align: center; }
  .key { display: inline-block; width: .7rem; height: .7rem; border-radius: 2px; vertical-align: -1px; }
  .key.ready { background: #1a7f37; }
  .key.all { background: var(--line); }
</style>
</head>
<body>
<main>
  <h1>Issue readiness</h1>
  <p class="sub">${escapeHtml(repo)} · generated ${escapeHtml(summary.generatedAt.slice(0, 16).replace("T", " "))} UTC</p>

  ${verdict(summary)}

  <div class="cards">
    <div class="card"><div class="big">${summary.scored}</div><div class="cap">issues scored</div></div>
    <div class="card"><div class="big">${share === null ? "—" : `${Math.round(share * 100)}%`}</div><div class="cap">of split work is delegatable</div></div>
    <div class="card"><div class="big">${summary.untracked}</div><div class="cap">not yet scored</div></div>
  </div>

  <h2>Does the feedback work?</h2>
  ${feedbackPanel(summary.feedback)}

  <h2>Issues opened per week</h2>
  ${trendChart(summary.trend)}

  <h2>Where issues land</h2>
  <div class="wrap">
    <table>
      <thead>
        <tr><th scope="col">Label</th><th scope="col" class="num">Issues</th><th scope="col"></th><th scope="col" class="num">Closed</th><th scope="col" class="num">Median to close</th></tr>
      </thead>
      <tbody>${summary.labels.map((l) => bar(l, max)).join("")}
      </tbody>
    </table>
  </div>

  <footer>
    Median time-to-close covers closed issues only, so a label with few
    closures shows a noisy figure. Issues opened before this tool was adopted
    carry no label and appear only in the &ldquo;not yet scored&rdquo; count.
  </footer>
</main>
</body>
</html>
`;
}
