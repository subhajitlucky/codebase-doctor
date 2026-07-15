import { SEVERITIES, type Finding, type Severity } from "./findings.js";

export interface FindingSummary {
  total: number;
  counts: Record<Severity, number>;
  highestSeverity: Severity | null;
}

export type FindingThreshold = Severity | "none";

export function hasFindingAtOrAbove(
  findings: readonly Finding[],
  threshold: FindingThreshold,
): boolean {
  if (threshold === "none") return false;
  const thresholdIndex = SEVERITIES.indexOf(threshold);
  return findings.some(({ severity }) => SEVERITIES.indexOf(severity) >= thresholdIndex);
}

export function summarizeFindings(findings: readonly Finding[]): FindingSummary {
  const counts: Record<Severity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  let highestSeverity: Severity | null = null;
  for (let index = SEVERITIES.length - 1; index >= 0; index -= 1) {
    const severity = SEVERITIES[index];
    if (severity !== undefined && counts[severity] > 0) {
      highestSeverity = severity;
      break;
    }
  }

  return { total: findings.length, counts, highestSeverity };
}
