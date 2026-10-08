import type { Severity } from "./findings.js";
import type { DomainCoverage } from "./domain-coverage.js";
import type { DoctorRunRecord, ScanResult } from "./normalize.js";

export type ScoreBand = "red" | "yellow" | "green";

export interface ScoreReport {
  value: number;
  band: ScoreBand;
  findingPenalty: number;
  coveragePenalty: number;
}

export const SEVERITY_PENALTIES: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 4,
  high: 10,
  critical: 25,
};

export const INCOMPLETE_COVERAGE_PENALTY = 10;
export const GREEN_MINIMUM = 80;
export const YELLOW_MINIMUM = 50;

export function bandForScore(value: number): ScoreBand {
  if (value >= GREEN_MINIMUM) return "green";
  if (value >= YELLOW_MINIMUM) return "yellow";
  return "red";
}

/**
 * Deterministic Repo Health score: 100 minus weighted findings minus a fixed
 * penalty when applicable coverage did not complete. Suppressed findings are
 * acknowledged and never counted. The score never replaces the report; it is
 * a bounded summary of it.
 */
export function scoreReport(
  findings: readonly { severity: Severity }[],
  domainCoverage: readonly DomainCoverage[],
  doctorRuns: readonly DoctorRunRecord[],
): ScoreReport {
  const findingPenalty = findings.reduce(
    (total, finding) => total + SEVERITY_PENALTIES[finding.severity],
    0,
  );
  const coverageIncomplete =
    domainCoverage.some((domain) => !domain.coverageComplete) ||
    doctorRuns.some((run) => run.status === "failed");
  const coveragePenalty = coverageIncomplete ? INCOMPLETE_COVERAGE_PENALTY : 0;
  const value = Math.max(0, Math.min(100, 100 - findingPenalty - coveragePenalty));
  return { value, band: bandForScore(value), findingPenalty, coveragePenalty };
}

export function scoreScanResult(result: ScanResult): ScoreReport {
  return result.score ?? scoreReport(result.findings, result.domainCoverage, result.doctorRuns);
}
