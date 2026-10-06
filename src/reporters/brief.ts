import { compareFindings, type Finding } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";
import { coverageLimitations, skippedPlannedChecks } from "../core/verify.js";

export interface BriefRenderOptions {
  maxFindings?: number;
}

const DEFAULT_MAX_FINDINGS = 100;
const MAX_REMEDIATION_CHARS = 140;
const MAX_SKIPPED_CHECKS = 5;
const MAX_SUPPRESSED_LINES = 25;

function location(finding: Finding): string {
  if (finding.location === undefined) return "(repository)";
  const line = finding.location.line === undefined ? "" : `:${finding.location.line}`;
  return `${finding.location.path}${line}`;
}

function oneLine(finding: Finding): string {
  const text = (finding.remediation ?? "Review and repair this finding.")
    .replace(/\s+/g, " ")
    .trim();
  const bounded =
    text.length <= MAX_REMEDIATION_CHARS
      ? text
      : `${text.slice(0, MAX_REMEDIATION_CHARS - 1)}…`;
  return `[${finding.severity}] ${finding.ruleId} ${location(finding)} — ${bounded}`;
}

/**
 * Token-bounded, findings-only output for coding agents: one line per finding,
 * a scope/coverage header, and explicit truncation. Never claims coverage that
 * did not complete.
 */
export function renderBriefReport(
  result: ScanResult,
  options: BriefRenderOptions = {},
): string {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const findings = [...result.findings].sort(compareFindings);
  const shown = findings.slice(0, maxFindings);
  const limitations = coverageLimitations(result);

  const headerParts = [
    `scope=${result.auditScope.mode}`,
    `findings=${findings.length}`,
    `shown=${shown.length}`,
    `coverage=${limitations.length === 0 ? "complete" : "incomplete"}`,
  ];

  if (result.comparison !== undefined) {
    headerParts.push(
      `new=${result.comparison.new.length}`,
      `resolved=${result.comparison.resolved.length}`,
    );
  }

  const lines: string[] = [
    "codebase-doctor brief",
    headerParts.join(" "),
  ];

  const newFingerprints =
    result.comparison === undefined ? undefined : new Set(result.comparison.new);

  for (const finding of shown) {
    const marker =
      newFingerprints === undefined
        ? ""
        : newFingerprints.has(finding.fingerprint)
          ? "+ "
          : "= ";
    lines.push(`${marker}${oneLine(finding)}`);
  }

  if (findings.length > shown.length) {
    lines.push(
      `truncated: ${findings.length - shown.length} more finding(s); use --format json for full evidence`,
    );
  }

  if (limitations.length > 0) {
    lines.push(`coverage-limitations: ${limitations.join(", ")}`);
  }

  if (result.suppressed.length > 0) {
    lines.push(
      `suppressed: ${result.suppressed.length} finding(s) acknowledged via codebase-doctor-ignore ` +
      `(excluded from gates, still present, listed in json)`,
    );
    for (const entry of result.suppressed.slice(0, MAX_SUPPRESSED_LINES)) {
      const location = entry.location === undefined
        ? "(repository)"
        : `${entry.location.path}${entry.location.line === undefined ? "" : `:${entry.location.line}`}`;
      const reason = entry.reason.length === 0 ? "no reason recorded" : entry.reason;
      lines.push(`~ [${entry.severity}] ${entry.ruleId} ${location} — ${reason}`);
    }
    if (result.suppressed.length > MAX_SUPPRESSED_LINES) {
      lines.push(
        `suppressed-truncated: ${result.suppressed.length - MAX_SUPPRESSED_LINES} more; use --format json for the full list`,
      );
    }
  }

  const skippedChecks = skippedPlannedChecks(result);
  if (skippedChecks.length > 0) {
    const shown = skippedChecks.slice(0, MAX_SKIPPED_CHECKS);
    const omitted = skippedChecks.length - shown.length;
    lines.push(
      `planned-checks-not-run (${skippedChecks.length}): ${shown.join("; ")}` +
      (omitted > 0 ? `; …and ${omitted} more` : "") +
      " — detected but never executed; rerun with --run-checks after explicit approval",
    );
  }

  return `${lines.join("\n")}\n`;
}
