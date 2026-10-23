import type { Severity } from "../../../core/findings.js";

export type ProbeStatus = "rows" | "none" | "denied" | "error";

export interface ProbeTarget {
  schema: string;
  table: string;
  ownerColumn: string | null;
}

export interface ProbeExecutionResult {
  role: string;
  subject: string | null;
  schema: string;
  table: string;
  status: ProbeStatus;
  sampledRows: number;
  ownerColumn: string | null;
  distinctOwners: number | null;
  ownRows: number | null;
  foreignRows: number | null;
  error: string | null;
  sessionDependentSettings: string[];
}

export interface ProbeRoleError {
  role: string;
  message: string;
}

export interface ProbeRunResult {
  probes: ProbeExecutionResult[];
  roleErrors: ProbeRoleError[];
}

export interface ProbeFinding {
  id: string;
  severity: Severity;
  schema: string | null;
  table: string | null;
  title: string;
  detail: string;
  recommendation: string;
  identity: readonly string[];
}

export interface ProbeReport {
  schemaVersion: "1.0";
  schemas: string[];
  roles: string[];
  summary: {
    probes: number;
    byStatus: Record<ProbeStatus, number>;
    findings: Record<Severity, number>;
    highestSeverity: Severity | "none";
  };
  probes: ProbeExecutionResult[];
  findings: ProbeFinding[];
}
