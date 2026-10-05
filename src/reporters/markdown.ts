import type { Finding } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";
import { coverageLimitations } from "../core/verify.js";
import type { ReviewVerdict } from "../review/verdict.js";

export interface MarkdownReviewOptions {
  verdict: ReviewVerdict;
  failOn: string;
  /** Maximum findings rendered in the body. Defaults to 50. */
  maxFindings?: number;
  /** Findings present in the full audit but outside the review diff. */
  excludedCount?: number;
  /** True when a baseline comparison narrowed the verdict to new findings. */
  baselineFiltered?: boolean;
  linePrecision?: boolean;
  rerunCommand?: string;
}

const DEFAULT_MAX_FINDINGS = 50;
const MAX_MESSAGE_CHARS = 400;
const MAX_REMEDIATION_CHARS = 240;
const MAX_SCOPE_LIST_ITEMS = 20;
const MAX_IMPACT_ITEMS = 10;

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  APPROVE: "🟢",
  COMMENT: "🟡",
  REQUEST_CHANGES: "🔴",
};

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function location(finding: Finding): string {
  if (finding.location === undefined) return "(repository)";
  const line = finding.location.line === undefined ? "" : `:${finding.location.line}`;
  const column = finding.location.column === undefined ? "" : `:${finding.location.column}`;
  return `${finding.location.path}${line}${column}`;
}

function findingBlock(finding: Finding): string[] {
  const lines = [
    `- **[${finding.severity}] \`${finding.ruleId}\` \`${location(finding)}\`** — ${truncate(finding.title, 160)}`,
  ];
  lines.push(`  > ${truncate(finding.message, MAX_MESSAGE_CHARS)}`);
  if (finding.remediation !== undefined) {
    lines.push(`  > Remediation: ${truncate(finding.remediation, MAX_REMEDIATION_CHARS)}`);
  }
  return lines;
}

/**
 * Render a PR-comment-ready Markdown review: verdict first, then the
 * diff-scoped findings, impact, and the coverage limitations that qualify the
 * result. Never claims coverage that did not complete.
 */
export function renderMarkdownReview(
  result: ScanResult,
  findingsInScope: readonly Finding[],
  options: MarkdownReviewOptions,
): string {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const shown = findingsInScope.slice(0, maxFindings);
  const limitations = coverageLimitations(result);
  const coverage = limitations.length === 0 ? "complete" : "incomplete";
  const excluded = options.excludedCount ?? 0;

  const lines: string[] = [
    `## Codebase Doctor Review — ${VERDICT_EMOJI[options.verdict]} ${options.verdict}`,
    "",
    `Scope: changed · findings in diff: ${findingsInScope.length} · ` +
    `total findings: ${result.findings.length} · coverage: ${coverage} · ` +
    `fail-on: ${options.failOn}`,
  ];

  if (result.comparison !== undefined) {
    lines.push(
      `Baseline: new ${result.comparison.new.length} · ` +
      `unchanged ${result.comparison.unchanged.length} · ` +
      `resolved ${result.comparison.resolved.length}` +
      (options.baselineFiltered === true ? " · verdict gated on new findings in diff" : ""),
    );
  }

  const { auditScope } = result;
  if (auditScope.base !== null) {
    lines.push(
      `Base: ${auditScope.base.kind} ${auditScope.base.requestedRef ?? "default"} ` +
      `(${auditScope.base.resolvedCommit.slice(0, 12)}) · ` +
      `changed paths: ${auditScope.changes.length}`,
    );
  } else {
    lines.push(`Changed paths: ${auditScope.changes.length}`);
  }
  if (options.linePrecision === false) {
    lines.push(
      "Changed-line mapping was unavailable; this review fell back to file-level filtering.",
    );
  }

  lines.push("", "### Findings in diff");

  if (shown.length === 0) {
    lines.push(
      auditScope.mode === "changed" && findingsInScope.length === 0 && result.findings.length > 0
        ? "No findings touch the changed lines. Findings elsewhere in the repository are out of scope for this review."
        : "No findings in scope.",
    );
  } else {
    for (const finding of shown) lines.push(...findingBlock(finding));
    if (findingsInScope.length > shown.length) {
      lines.push(
        `_…and ${findingsInScope.length - shown.length} more finding(s); ` +
        `use \`--format json\` for full evidence._`,
      );
    }
  }

  if (excluded > 0) {
    lines.push(
      "",
      `_${excluded} finding(s) outside the changed lines are omitted from this review; ` +
      `rerun with \`--all-findings\` or \`audit --format json\` to see them._`,
    );
  }

  const impact = result.sourceImpact;
  if (impact !== undefined && impact.mode === "changed") {
    lines.push("", "### Source impact");
    lines.push(
      `Changed source roots: ${impact.changedSourcePaths.length} · ` +
      `impacted files: ${impact.impactedFileCount}`,
    );
    for (const record of impact.impacts.slice(0, MAX_IMPACT_ITEMS)) {
      lines.push(`- \`${record.dependencyPath.join(" → ")}\``);
    }
    const omitted = impact.omittedImpactCount +
      Math.max(0, impact.impacts.length - MAX_IMPACT_ITEMS);
    if (omitted > 0) lines.push(`- _…and ${omitted} more impact record(s)._`);
  }

  if (auditScope.changes.length > 0) {
    lines.push("", "### Changed paths");
    for (const change of auditScope.changes.slice(0, MAX_SCOPE_LIST_ITEMS)) {
      lines.push(`- ${change.status}: \`${change.path}\``);
    }
    if (auditScope.changes.length > MAX_SCOPE_LIST_ITEMS) {
      lines.push(`- _…and ${auditScope.changes.length - MAX_SCOPE_LIST_ITEMS} more._`);
    }
  }

  lines.push("", "### Coverage limitations");
  if (limitations.length === 0) {
    lines.push(
      "Declared domain coverage completed. Complete coverage describes the " +
      "declared audit execution; it is not proof that the code is bug-free or correct.",
    );
  } else {
    for (const limitation of limitations) lines.push(`- ${limitation}`);
    lines.push(
      "Do not call this codebase clean or verified without reviewing these limitations.",
    );
  }

  lines.push(
    "",
    "---",
    `_Generated by codebase-doctor ${result.tool.version} · ` +
    `\`${options.rerunCommand ?? "codebase-doctor review . --format markdown"}\` · ` +
    `Models build. Codebase Doctor verifies._`,
  );

  return `${lines.join("\n")}\n`;
}
