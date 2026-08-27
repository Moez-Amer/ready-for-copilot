import {
  formatDuration,
  type Summary,
  type LabelStat,
  type FeedbackEffect,
  type TrendBucket,
} from "./stats.js";

/**
 * Each label's meaning and hue.
 *
 * The three stripe colours double as the semantic set, so the brand mark and
 * the data speak one language: green is ready, amber needs work, red is
 * blocked. Blue sits outside that spectrum, for work that is fine but human.
 */
const LABEL_META: Record<string, { hue: string; blurb: string }> = {
  "agent-ready": { hue: "#0fa336", blurb: "Specified, real, and safe to delegate" },
  mechanical: { hue: "#0fa336", blurb: "Sub-issue routed to the coding agent" },
  "needs-human": { hue: "#1c69d4", blurb: "Specified, but touches something sensitive" },
  judgement: { hue: "#1c69d4", blurb: "Sub-issue kept for a human" },
  "needs-detail": { hue: "#f4b400", blurb: "Scored below 4/4" },
  "not-in-codebase": { hue: "#e22718", blurb: "Describes code that is not there" },
  "not-a-task": { hue: "#7e7e7e", blurb: "A question or discussion, not work" },
};

const READY = "#0fa336";
const ATTENTION = "#f4b400";
const BLOCKED = "#e22718";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** A solid mark handing off to a dashed one: work passing from human to agent. */
const LOGO = `
<svg class="mark" viewBox="0 0 44 20" role="img" aria-label="Relay">
  <path d="M0 3 L9 10 L0 17 Z" fill="#ffffff"></path>
  <rect x="13" y="0" width="1.4" height="20" fill="#3c3c3c"></rect>
  <rect x="18.5" y="0" width="1.4" height="20" fill="#3c3c3c"></rect>
  <path d="M24 3 L33 10 L24 17 Z" fill="none" stroke="#ffffff" stroke-width="1.4"
        stroke-dasharray="3 2.2" stroke-linejoin="round"></path>
</svg>`;

/** The signature stripe. Brand identity only -- never a fill or a control. */
const STRIPE = `<div class="stripe" aria-hidden="true"><i style="background:${READY}"></i><i style="background:${ATTENTION}"></i><i style="background:${BLOCKED}"></i></div>`;

function statRow(stat: LabelStat, max: number): string {
  const meta = LABEL_META[stat.label] ?? { hue: "#7e7e7e", blurb: "" };
  const width = max > 0 ? (stat.total / max) * 100 : 0;
  return `
      <tr>
        <th scope="row">
          <span class="swatch" style="background:${meta.hue}"></span>
          <span class="lname">${escapeHtml(stat.label)}</span>
          <span class="lblurb">${escapeHtml(meta.blurb)}</span>
        </th>
        <td class="n">${stat.total}</td>
        <td class="track"><span class="fill" style="width:${width.toFixed(1)}%;background:${meta.hue}"></span></td>
        <td class="n">${stat.closed}</td>
        <td class="n">${formatDuration(stat.medianHoursToClose)}</td>
      </tr>`;
}

/** Whether issues the tool called ready actually resolve faster. */
function verdict(summary: Summary): string {
  const ready = summary.labels.find((l) => l.label === "agent-ready");
  const detail = summary.labels.find((l) => l.label === "needs-detail");

  if (!ready?.medianHoursToClose || !detail?.medianHoursToClose) {
    return `
    <p class="lede">Not enough closed issues to say whether the rubric predicts anything yet.</p>
    <p class="sub">It needs closures on both sides — currently ${ready?.closed ?? 0} closed as <b>agent-ready</b> against ${detail?.closed ?? 0} as <b>needs-detail</b>.</p>`;
  }

  const faster = ready.medianHoursToClose < detail.medianHoursToClose;
  const ratio = faster
    ? detail.medianHoursToClose / ready.medianHoursToClose
    : ready.medianHoursToClose / detail.medianHoursToClose;

  return faster
    ? `
    <p class="lede">Issues scored ready close <b style="color:${READY}">${ratio.toFixed(1)}× faster</b>.</p>
    <p class="sub">${formatDuration(ready.medianHoursToClose)} against ${formatDuration(detail.medianHoursToClose)}. The rubric is predicting something real.</p>`
    : `
    <p class="lede">Issues scored ready close <b style="color:${BLOCKED}">${ratio.toFixed(1)}× slower</b>.</p>
    <p class="sub">${formatDuration(ready.medianHoursToClose)} against ${formatDuration(detail.medianHoursToClose)}. The rubric is not predicting what it claims, which deserves more attention than the tool.</p>`;
}

/** Whether telling an author what is missing actually gets the issue fixed. */
function feedbackPanel(f: FeedbackEffect): string {
  if (!f.measured) {
    return `<p class="sub">Label history was unavailable, so there is no way to tell whether flagged issues were fixed.</p>`;
  }
  if (f.flagged === 0) {
    return `<p class="sub">Nothing has been flagged as needing work yet.</p>`;
  }
  const pct = Math.round((f.improved / f.flagged) * 100);
  const hue = pct >= 50 ? READY : ATTENTION;
  const timing =
    f.medianHoursToImprove !== null
      ? ` Median <b>${formatDuration(f.medianHoursToImprove)}</b> from flag to fix.`
      : "";
  return `
    <div class="funnel">
      <div class="fstage"><span class="fnum">${f.flagged}</span><span class="flabel">Flagged</span></div>
      <div class="fline" aria-hidden="true"></div>
      <div class="fstage"><span class="fnum" style="color:${hue}">${f.improved}</span><span class="flabel">Fixed after feedback</span></div>
      <div class="fstage fpct"><span class="fnum" style="color:${hue}">${pct}%</span><span class="flabel">Acted on</span></div>
    </div>
    <p class="sub">${
      pct >= 50
        ? `Most flagged issues get fixed, so the comments are changing behaviour.${timing}`
        : `Most flagged issues remain unfixed. Either the feedback is not landing, or nobody returns to it.${timing}`
    }</p>`;
}

/** Issues opened per week, and how many became delegatable. */
function trendChart(buckets: TrendBucket[]): string {
  if (buckets.length < 2) {
    return `<p class="sub">Not enough weeks of history to show a trend.</p>`;
  }
  const max = Math.max(...buckets.map((b) => b.opened), 1);
  const w = 100 / buckets.length;
  const bars = buckets
    .map((b, i) => {
      const x = i * w + w * 0.22;
      const bw = w * 0.56;
      const h = (b.opened / max) * 100;
      const rh = (b.ready / max) * 100;
      return `<rect x="${x.toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" fill="#262626"></rect><rect x="${x.toFixed(2)}" y="${(100 - rh).toFixed(2)}" width="${bw.toFixed(2)}" height="${rh.toFixed(2)}" fill="${READY}"></rect>`;
    })
    .join("");
  return `
    <div class="chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
           aria-label="Issues opened per week, with the delegatable share highlighted">${bars}</svg>
      <div class="xaxis">${buckets.map((b) => `<span>${escapeHtml(b.week.slice(5))}</span>`).join("")}</div>
      <p class="sub"><i class="key" style="background:${READY}"></i> Reached agent-ready &nbsp;&nbsp; <i class="key" style="background:#262626"></i> Opened</p>
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
<title>Relay — ${escapeHtml(repo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;700&family=JetBrains+Mono:wght@400;700&display=swap">
<style>
  /* Committed to a single dark surface, as the reference system is. Every
     colour is painted explicitly, so the page holds on any host background. */
  :root {
    --canvas: #000000;
    --elevated: #262626;
    --hairline: #3c3c3c;
    --ink: #ffffff;
    --body: #bbbbbb;
    --body-strong: #e6e6e6;
    --muted: #7e7e7e;
    --sans: "Archivo", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { background: var(--canvas); }
  body {
    margin: 0; background: var(--canvas); color: var(--body);
    font-family: var(--sans); font-weight: 300; font-size: 16px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 74rem; margin: 0 auto; padding: 0 24px; }

  header { border-bottom: 1px solid var(--hairline); }
  .masthead { display: flex; align-items: center; gap: 16px; height: 64px; }
  .mark { height: 18px; width: auto; display: block; flex: none; }
  .wordmark {
    font-weight: 700; font-size: 14px; letter-spacing: 1.5px;
    text-transform: uppercase; color: var(--ink);
  }
  .repo {
    margin-left: auto; font-family: var(--mono); font-size: 12px;
    color: var(--muted); letter-spacing: .5px; text-align: right;
  }
  .stripe { display: flex; height: 4px; }
  .stripe i { flex: 1; }

  .hero { padding: 96px 0 64px; }
  h1 {
    font-weight: 700; font-size: clamp(40px, 7vw, 80px); line-height: 1;
    letter-spacing: -.5px; text-transform: uppercase; color: var(--ink);
    margin: 0 0 40px; text-wrap: balance;
  }
  .lede {
    font-size: clamp(20px, 2.4vw, 32px); font-weight: 400; line-height: 1.25;
    color: var(--body-strong); margin: 0 0 12px; max-width: 32ch;
  }
  .lede b { font-weight: 700; }
  .sub { color: var(--muted); font-size: 14px; margin: 0; max-width: 66ch; }
  .sub b { color: var(--body-strong); font-weight: 500; }

  .figures {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    border-top: 1px solid var(--hairline);
  }
  .figure { padding: 40px 0 40px 24px; border-left: 1px solid var(--hairline); }
  .figure:first-child { padding-left: 0; border-left: 0; }
  .fig-n {
    display: block; font-family: var(--mono); font-weight: 700;
    font-size: 40px; line-height: 1; color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .fig-l {
    display: block; margin-top: 12px; font-size: 12px; font-weight: 700;
    letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted);
  }

  section { padding: 64px 0; border-top: 1px solid var(--hairline); }
  h2 {
    font-size: 14px; font-weight: 700; letter-spacing: 1.5px;
    text-transform: uppercase; color: var(--ink); margin: 0 0 24px;
  }

  .funnel { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; }
  .fstage { display: flex; flex-direction: column; gap: 8px; }
  .fnum {
    font-family: var(--mono); font-weight: 700; font-size: 32px; line-height: 1;
    color: var(--ink); font-variant-numeric: tabular-nums;
  }
  .flabel {
    font-size: 12px; font-weight: 700; letter-spacing: 1.5px;
    text-transform: uppercase; color: var(--muted);
  }
  .fline { flex: 0 0 64px; height: 1px; background: var(--hairline); }
  .fpct { margin-left: auto; text-align: right; }

  .chart svg { width: 100%; height: 160px; display: block; }
  .xaxis {
    display: flex; margin: 8px 0 16px; padding-top: 8px;
    border-top: 1px solid var(--hairline);
    font-family: var(--mono); font-size: 11px; color: var(--muted);
  }
  .xaxis span { flex: 1; text-align: center; }
  .key { display: inline-block; width: 10px; height: 10px; vertical-align: -1px; }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 34rem; }
  thead th {
    text-align: left; padding: 0 12px 12px 0; border-bottom: 1px solid var(--hairline);
    font-size: 11px; font-weight: 700; letter-spacing: 1.5px;
    text-transform: uppercase; color: var(--muted);
  }
  tbody th, tbody td {
    padding: 20px 12px 20px 0; border-bottom: 1px solid var(--elevated);
    vertical-align: middle; font-weight: 300;
  }
  tbody th { text-align: left; position: relative; padding-left: 22px; }
  .swatch { position: absolute; left: 0; top: 24px; width: 10px; height: 10px; }
  .lname { display: block; font-family: var(--mono); font-size: 13px; color: var(--ink); }
  .lblurb { display: block; margin-top: 4px; font-size: 12px; color: var(--muted); }
  .n {
    text-align: right; font-family: var(--mono); font-size: 14px;
    color: var(--body-strong); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .track { width: 38%; min-width: 7rem; }
  .fill { display: block; height: 6px; min-width: 2px; }

  footer {
    border-top: 1px solid var(--hairline); padding: 40px 0 96px;
    color: var(--muted); font-size: 12px; max-width: 68ch;
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="masthead">
      ${LOGO}
      <span class="wordmark">Relay</span>
      <span class="repo">${escapeHtml(repo)}</span>
    </div>
  </div>
  ${STRIPE}
</header>

<main class="wrap">
  <div class="hero">
    <h1>Issue readiness</h1>
    ${verdict(summary)}
  </div>

  <div class="figures">
    <div class="figure"><span class="fig-n">${summary.scored}</span><span class="fig-l">Issues scored</span></div>
    <div class="figure"><span class="fig-n">${share === null ? "—" : `${Math.round(share * 100)}%`}</span><span class="fig-l">Split work delegatable</span></div>
    <div class="figure"><span class="fig-n">${summary.untracked}</span><span class="fig-l">Not yet scored</span></div>
  </div>

  <section>
    <h2>Does the feedback work</h2>
    ${feedbackPanel(summary.feedback)}
  </section>

  <section>
    <h2>Issues opened per week</h2>
    ${trendChart(summary.trend)}
  </section>

  <section>
    <h2>Where issues land</h2>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col" class="n">Issues</th>
            <th scope="col"></th>
            <th scope="col" class="n">Closed</th>
            <th scope="col" class="n">Median</th>
          </tr>
        </thead>
        <tbody>${summary.labels.map((l) => statRow(l, max)).join("")}
        </tbody>
      </table>
    </div>
  </section>

  <footer>
    Median time-to-close counts closed issues only, so a label with few closures
    shows a noisy figure. Issues opened before Relay was adopted carry no label
    and appear only under &ldquo;not yet scored&rdquo;.
    <br><br>
    Generated ${escapeHtml(summary.generatedAt.slice(0, 16).replace("T", " "))} UTC.
  </footer>
</main>
</body>
</html>
`;
}
