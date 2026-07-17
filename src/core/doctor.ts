import type { Capability } from "./capabilities.js";
import type { Finding } from "./findings.js";
import type { ProjectSnapshot } from "../workspace/types.js";

export interface OperationalError {
  code: string;
  message: string;
}

export interface DoctorContext {
  snapshot: ProjectSnapshot;
  allowedCapabilities: ReadonlySet<Capability>;
}

export interface CheckRunRecord {
  planId: string;
  projectId: string;
  command: string;
  status: "passed" | "failed" | "timed-out" | "skipped";
  durationMs: number;
  exitCode?: number;
  reason?: string;
}

export type CoverageStatus =
  | "completed"
  | "partial"
  | "not-applicable"
  | "unsupported"
  | "not-selected"
  | "skipped"
  | "failed";

export interface AuditCoverage {
  moduleId: string;
  status: CoverageStatus;
  scope: string;
  filesExamined: number;
  statementsExamined: number;
  statementsRecognized: number;
  limitations: readonly string[];
}

export interface DoctorResult {
  status: "completed" | "skipped" | "failed";
  findings: readonly Finding[];
  error?: OperationalError;
  skipReason?: string;
  checkRuns?: readonly CheckRunRecord[];
  coverage?: readonly AuditCoverage[];
  durationMs: number;
}

export interface Doctor {
  id: string;
  version: string;
  capabilities: readonly Capability[];
  supports(snapshot: ProjectSnapshot): boolean | Promise<boolean>;
  diagnose(context: DoctorContext): Promise<DoctorResult>;
}

export interface RegisteredDoctorResult {
  doctorId: string;
  result: DoctorResult;
}
