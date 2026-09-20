import { SEVERITIES, type Finding, type Severity } from "./findings.js";
import type { ScanResult } from "./normalize.js";
import type { FindingThreshold } from "./summary.js";

export type VerifyStatus = "resolved" | "unchanged" | "unresolved" | "new";

export interface VerifyEntry {
  fingerprint: string;
  status: VerifyStatus;
  severity: Severity;
  doctorId: string;
  ruleId: string;
  title: string;
  location?: Finding["location"];
  remediation: string;
  verification?: Finding["verification"];
}

export interface VerifyResult {
  schemaVersion: "1";
  scope: ScanResult["auditScope"];
  coverageComplete: boolean;
  coverageLimitations: readonly string[];
  counts: Record<VerifyStatus, number>;
  baseline: readonly VerifyEntry[];
  newFindings: readonly VerifyEntry[];
}

export interface VerifyExitOptions {
  allowUnchanged?: boolean;
}

const severityRank = new Map<Severity, number>(
  SEVERITIES.map((severity, index) => [severity, index]),
);

function compareEntries(left: VerifyEntry, right: VerifyEntry): number {
  const severityDifference =
    (severityRank.get(right.severity) ?? 0) - (severityRank.get(left.severity) ?? 0);
  if (severityDifference !== 0) return severityDifference;

  const pathDifference = (left.location?.path ?? "").localeCompare(
    right.location?.path ?? "",
  );
  if (pathDifference !== 0) return pathDifference;

  const ruleDifference = left.ruleId.localeCompare(right.ruleId);
  if (ruleDifference !== 0) return ruleDifference;

  return left.fingerprint.localeCompare(right.fingerprint);
}

function toEntry(finding: Finding, status: VerifyStatus): VerifyEntry {
  const ruleId =
    typeof finding.ruleId === "string" && finding.ruleId.length > 0
      ? finding.ruleId
      : "unknown-rule";
  const title =
    typeof finding.title === "string" && finding.title.length > 0
      ? finding.title
      : ruleId;

  return {
    fingerprint: finding.fingerprint,
    status,
    severity: finding.severity,
    doctorId:
      typeof finding.doctorId === "string" && finding.doctorId.length > 0
        ? finding.doctorId
        : "unknown-doctor",
    ruleId,
    title,
    ...(finding.location === undefined ? {} : { location: finding.location }),
    remediation:
      typeof finding.remediation === "string" && finding.remediation.length > 0
        ? finding.remediation
        : "Review and repair this finding.",
    ...(finding.verification === undefined ? {} : { verification: finding.verification }),
  };
}

/**
 * Coverage limitations that prevent proving an absent finding was repaired:
 * incomplete domains plus failed doctor runs.
 */
export function coverageLimitations(result: ScanResult): string[] {
  const limitations: string[] = [];

  for (const domain of result.domainCoverage) {
    if (!domain.coverageComplete) {
      limitations.push(`${domain.domain}: ${domain.status}`);
    }
  }

  for (const run of result.doctorRuns) {
    if (run.status === "failed") {
      limitations.push(`${run.doctorId}: failed`);
    }
  }

  return limitations;
}

/**
 * Compare a prior baseline with a fresh scan. A baseline finding is only
 * `resolved` when its fingerprint is absent and all applicable coverage
 * completed; absence under incomplete coverage is `unresolved`, never a fix.
 */
export function verifyRepairs(
  baseline: readonly Finding[],
  result: ScanResult,
): VerifyResult {
  const currentByFingerprint = new Map(
    result.findings.map((finding) => [finding.fingerprint, finding]),
  );
  const baselineFingerprints = new Set(
    baseline.map((finding) => finding.fingerprint),
  );
  const limitations = coverageLimitations(result);
  const coverageComplete = limitations.length === 0;

  const baselineEntries = baseline
    .map((finding) => {
      const current = currentByFingerprint.get(finding.fingerprint);
      const source = current ?? finding;
      const status: VerifyStatus =
        current !== undefined ? "unchanged" : coverageComplete ? "resolved" : "unresolved";
      return toEntry(source, status);
    })
    .sort(compareEntries);

  const newEntries = result.findings
    .filter((finding) => !baselineFingerprints.has(finding.fingerprint))
    .map((finding) => toEntry(finding, "new"))
    .sort(compareEntries);

  return {
    schemaVersion: "1",
    scope: result.auditScope,
    coverageComplete,
    coverageLimitations: limitations,
    counts: {
      resolved: baselineEntries.filter((entry) => entry.status === "resolved").length,
      unchanged: baselineEntries.filter((entry) => entry.status === "unchanged").length,
      unresolved: baselineEntries.filter((entry) => entry.status === "unresolved").length,
      new: newEntries.length,
    },
    baseline: baselineEntries,
    newFindings: newEntries,
  };
}

/**
 * Exit 0 only when every baseline finding is verifiably resolved, no baseline
 * finding remains (unless `allowUnchanged`), and no new finding meets the
 * threshold. Unresolved entries always fail: absence under incomplete coverage
 * is not a repair.
 */
export function classifyVerifyExit(
  verification: VerifyResult,
  failOn: FindingThreshold,
  options: VerifyExitOptions = {},
): 0 | 1 | 2 {
  if (verification.counts.unresolved > 0) return 1;
  if (verification.counts.unchanged > 0 && options.allowUnchanged !== true) return 1;

  if (failOn !== "none") {
    const threshold = severityRank.get(failOn) ?? severityRank.get("high")!;
    const failing = verification.newFindings.some(
      (entry) => (severityRank.get(entry.severity) ?? 0) >= threshold,
    );
    if (failing) return 1;
  }

  return 0;
}
