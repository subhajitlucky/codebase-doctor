import type { Finding } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";
import { scoreScanResult, type ScoreBand } from "../core/score.js";
import { coverageLimitations } from "../core/verify.js";

const BAND_COLORS: Record<ScoreBand, string> = {
  green: "#2ea043",
  yellow: "#d29922",
  red: "#f85149",
};

const SEVERITY_COLORS: Record<Finding["severity"], string> = {
  critical: "#f85149",
  high: "#ff8c42",
  medium: "#d29922",
  low: "#58a6ff",
  info: "#8b949e",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function locationText(finding: Finding): string {
  if (finding.location === undefined) return "(repository)";
  const line = finding.location.line === undefined ? "" : `:${finding.location.line}`;
  return `${finding.location.path}${line}`;
}

function findingHtml(finding: Finding): string {
  const parts = [
    `<article class="finding">`,
    `<header><span class="severity" style="background:${SEVERITY_COLORS[finding.severity]}">${escapeHtml(finding.severity)}</span>`,
    `<code>${escapeHtml(finding.ruleId)}</code>`,
    `<span class="location">${escapeHtml(locationText(finding))}</span></header>`,
    `<p>${escapeHtml(finding.message)}</p>`,
  ];
  if (finding.remediation !== undefined) {
    parts.push(`<p class="remediation">Remediation: ${escapeHtml(finding.remediation)}</p>`);
  }
  if (finding.verification !== undefined) {
    parts.push(
      `<p class="verification">Verify: <code>${escapeHtml(finding.verification.command)}</code></p>`,
    );
  }
  parts.push(`</article>`);
  return parts.join("\n");
}

/**
 * Standalone, dependency-free HTML report: shareable evidence with the score,
 * findings, and coverage limitations. Every dynamic value is escaped.
 */
export function renderHtmlReport(result: ScanResult): string {
  const score = scoreScanResult(result);
  const limitations = coverageLimitations(result);
  const counts = result.summary.counts;

  const sections: string[] = [
    `<header class="masthead">`,
    `<h1>Codebase Doctor report</h1>`,
    `<p class="meta">${escapeHtml(result.repository.root)} · ${escapeHtml(result.tool.name)} ${escapeHtml(result.tool.version)} · scope=${escapeHtml(result.auditScope.mode)}</p>`,
    `</header>`,
    `<section class="score">`,
    `<div class="value" style="color:${BAND_COLORS[score.band]}">${score.value}<span>/100</span></div>`,
    `<div class="label">Repo Health · ${escapeHtml(score.band)}</div>`,
    `<div class="penalties">findings −${score.findingPenalty} · coverage −${score.coveragePenalty}</div>`,
    `</section>`,
    `<section class="summary">`,
    `<p>${result.summary.total} finding(s): critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}, info ${counts.info}</p>`,
    `<p class="coverage">Coverage: ${limitations.length === 0 ? "complete for the selected scope" : "incomplete"}</p>`,
    ...(limitations.length === 0
      ? []
      : [`<ul>${limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul>`]),
    ...(result.coverageSummary === undefined
      ? []
      : [
          `<p class="coverage">Bounded evidence: ${result.coverageSummary.emitted} of ${result.coverageSummary.total} record(s) emitted, ${result.coverageSummary.omitted} omitted.</p>`,
        ]),
    `</section>`,
    `<section class="findings">`,
    result.findings.length === 0
      ? `<p class="clean">No findings for the selected scope.</p>`
      : result.findings.map(findingHtml).join("\n"),
    `</section>`,
  ];

  if (result.suppressed.length > 0) {
    sections.push(
      `<section class="suppressed">`,
      `<h2>Suppressed findings (${result.suppressed.length})</h2>`,
      `<p>Acknowledged with codebase-doctor-ignore directives; excluded from gates, still present.</p>`,
      `<ul>${result.suppressed
        .map((entry) => `<li>[${escapeHtml(entry.severity)}] ${escapeHtml(entry.ruleId)} — ${escapeHtml(entry.reason)}</li>`)
        .join("")}</ul>`,
      `</section>`,
    );
  }

  sections.push(
    `<footer>Read-only report. Coverage limitations are part of the result — inspect them before calling a codebase verified.</footer>`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codebase Doctor report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 20px; background: #0f1115; color: #e6e9ef; font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; }
  .meta { color: #8b93a3; margin: 0 0 28px; }
  .score { display: flex; align-items: baseline; gap: 16px; background: #171a21; border: 1px solid #2a2f3a; border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; flex-wrap: wrap; }
  .score .value { font-size: 44px; font-weight: 700; }
  .score .value span { font-size: 18px; color: #8b93a3; }
  .score .label { font-weight: 600; }
  .score .penalties { color: #8b93a3; margin-left: auto; }
  section.summary { margin-bottom: 24px; color: #aeb6c4; }
  section.summary ul { margin: 8px 0 0; padding-left: 20px; }
  .finding { background: #171a21; border: 1px solid #2a2f3a; border-radius: 12px; padding: 16px 20px; margin-bottom: 12px; }
  .finding header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .finding p { margin: 6px 0 0; }
  .severity { color: #0f1115; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 12px; text-transform: uppercase; }
  .location, .remediation, .verification, .coverage { color: #8b93a3; }
  .clean { color: #2ea043; }
  .suppressed { margin-top: 24px; color: #aeb6c4; }
  footer { margin-top: 32px; color: #6b7280; font-size: 13px; }
  code { background: #1f242e; padding: 1px 6px; border-radius: 6px; }
</style>
</head>
<body>
<main>
${sections.join("\n")}
</main>
</body>
</html>
`;
}
