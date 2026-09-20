import { compareFindings, type Finding } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";
import { coverageLimitations } from "../core/verify.js";

export interface BriefRenderOptions {
  maxFindings?: number;
}

const DEFAULT_MAX_FINDINGS = 100;
const MAX_REMEDIATION_CHARS = 140;

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

  return `${lines.join("\n")}\n`;
}
