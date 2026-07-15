import type {
  CheckRunRecord,
  OperationalError,
  RegisteredDoctorResult,
} from "./doctor.js";
import { sortFindings, type Finding } from "./findings.js";
import {
  hasFindingAtOrAbove,
  summarizeFindings,
  type FindingSummary,
  type FindingThreshold,
} from "./summary.js";
import { VERSION } from "../index.js";
import type { DetectedProject } from "../workspace/types.js";

export interface DoctorRunRecord {
  doctorId: string;
  status: "completed" | "skipped" | "failed";
  durationMs: number;
  findingCount: number;
  error: OperationalError | null;
  skipReason: string | null;
  checkRuns: readonly CheckRunRecord[];
}

export interface ScanResult {
  schemaVersion: "1";
  tool: { name: "codebase-doctor"; version: string };
  repository: { root: string };
  projects: readonly DetectedProject[];
  doctorRuns: readonly DoctorRunRecord[];
  findings: readonly Finding[];
  summary: FindingSummary;
}

function exactFindingKey(finding: Finding): string {
  return JSON.stringify(finding);
}

function uniqueFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return sortFindings(findings).filter((finding) => {
    const key = exactFindingKey(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function doctorRun(entry: RegisteredDoctorResult): DoctorRunRecord {
  return {
    doctorId: entry.doctorId,
    status: entry.result.status,
    durationMs: entry.result.durationMs,
    findingCount: new Set(entry.result.findings.map(exactFindingKey)).size,
    error: entry.result.error ?? null,
    skipReason: entry.result.skipReason ?? null,
    checkRuns: entry.result.checkRuns ?? [],
  };
}

export function normalizeScanResult(
  root: string,
  projects: readonly DetectedProject[],
  registeredResults: readonly RegisteredDoctorResult[],
): ScanResult {
  const findings = uniqueFindings(registeredResults.flatMap(({ result }) => result.findings));
  const doctorRuns = registeredResults
    .map(doctorRun)
    .sort((left, right) => left.doctorId < right.doctorId ? -1 : left.doctorId > right.doctorId ? 1 : 0);

  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: VERSION },
    repository: { root },
    projects: [...projects].sort((left, right) =>
      left.root < right.root ? -1 : left.root > right.root ? 1 : 0,
    ),
    doctorRuns,
    findings,
    summary: summarizeFindings(findings),
  };
}

export function classifyScanExit(
  result: ScanResult,
  failOn: FindingThreshold,
): 0 | 1 | 2 {
  if (result.doctorRuns.some(({ status }) => status === "failed")) return 2;
  return hasFindingAtOrAbove(result.findings, failOn) ? 1 : 0;
}
