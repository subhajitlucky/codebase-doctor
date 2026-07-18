import type {
  CheckRunRecord,
  AuditCoverage,
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
import { VERSION } from "../version.js";
import type { DetectedProject } from "../workspace/types.js";
import type { PlannedCheckRecord } from "../execution/types.js";
import type { FindingComparison } from "./baseline.js";
import type { AuditScope, ChangedPath, ScopeReason } from "../scope/types.js";
import type { SourceImpact, SourceImpactRecord } from "../source-graph/types.js";
import {
  AUDIT_DOMAINS,
  type DomainCoverage,
  type DomainCoverageEvidence,
} from "./domain-coverage.js";
import {
  boundLimitations,
  boundRecords,
  MAX_COVERAGE_RECORDS,
  type OmittedRecordSummary,
} from "./bounded-evidence.js";

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
  auditScope: AuditScope;
  plannedChecks: readonly PlannedCheckRecord[];
  domainCoverage: readonly DomainCoverage[];
  doctorRuns: readonly DoctorRunRecord[];
  findings: readonly Finding[];
  summary: FindingSummary;
  coverage?: readonly AuditCoverage[];
  coverageSummary?: OmittedRecordSummary;
  comparison?: FindingComparison;
  sourceImpact?: SourceImpact;
}

function normalizeSourceImpact(sourceImpact: SourceImpact): SourceImpact {
  const boundedLimitations = boundLimitations(sourceImpact.limitations);
  return {
    ...sourceImpact,
    changedSourcePaths: [...new Set(sourceImpact.changedSourcePaths)].sort(),
    impactedProjectIds: [...new Set(sourceImpact.impactedProjectIds)].sort(),
    impacts: sourceImpact.impacts
      .map((impact): SourceImpactRecord => ({
        ...impact,
        dependencyPath: [...impact.dependencyPath],
      }))
      .sort((left, right) =>
        left.path.localeCompare(right.path) ||
        left.dependencyPath.join("\0").localeCompare(right.dependencyPath.join("\0")) ||
        (left.projectId ?? "").localeCompare(right.projectId ?? "")
      ),
    limitations: boundedLimitations.limitations,
    ...(boundedLimitations.groups.length === 0
      ? {}
      : { limitationGroups: boundedLimitations.groups }),
    ...(boundedLimitations.summary.omitted === 0
      ? {}
      : { limitationSummary: boundedLimitations.summary }),
  };
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
  auditScope: AuditScope,
  registeredResults: readonly RegisteredDoctorResult[],
  plannedChecks: readonly PlannedCheckRecord[] = [],
  domainCoverage: readonly DomainCoverage[] = [],
  sourceImpact?: SourceImpact,
): ScanResult {
  const findings = uniqueFindings(registeredResults.flatMap(({ result }) => result.findings));
  const doctorRuns = registeredResults
    .map(doctorRun)
    .sort((left, right) => left.doctorId < right.doctorId ? -1 : left.doctorId > right.doctorId ? 1 : 0);
  const normalizedCoverage = registeredResults
    .flatMap(({ result }) => result.coverage ?? [])
    .map((entry): AuditCoverage => {
      const bounded = boundLimitations(entry.limitations);
      return {
        ...entry,
        limitations: bounded.limitations,
        ...(bounded.groups.length === 0 ? {} : { limitationGroups: bounded.groups }),
        ...(bounded.summary.omitted === 0 ? {} : { limitationSummary: bounded.summary }),
      };
    })
    .sort((left, right) => {
      const moduleOrder = left.moduleId.localeCompare(right.moduleId);
      return moduleOrder !== 0 ? moduleOrder : left.scope.localeCompare(right.scope);
    });
  const coverageStatusPriority: Record<AuditCoverage["status"], number> = {
    failed: 0,
    partial: 1,
    unsupported: 2,
    skipped: 3,
    "not-selected": 4,
    completed: 5,
    "not-applicable": 6,
  };
  const prioritizeCoverage = normalizedCoverage.length > MAX_COVERAGE_RECORDS;
  const boundedCoverage = boundRecords(
    normalizedCoverage,
    (entry) => `${prioritizeCoverage ? coverageStatusPriority[entry.status] : 0}\0` +
      `${entry.moduleId}\0${entry.scope}`,
  );
  const coverage = boundedCoverage.records;
  const normalizedAuditScope: AuditScope = {
    mode: auditScope.mode,
    base: auditScope.base === null ? null : { ...auditScope.base },
    changes: auditScope.changes
      .map((change): ChangedPath => ({ ...change }))
      .sort((left, right) =>
        left.path.localeCompare(right.path) ||
        (left.previousPath ?? "").localeCompare(right.previousPath ?? "") ||
        left.status.localeCompare(right.status),
      ),
    affectedProjectIds: [...auditScope.affectedProjectIds].sort(),
    reasons: auditScope.reasons
      .map((reason): ScopeReason => ({ ...reason }))
      .sort((left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.reason.localeCompare(right.reason) ||
        left.source.localeCompare(right.source),
      ),
    limitations: [...auditScope.limitations].sort(),
  };
  const normalizedDomainCoverage = domainCoverage
    .map((entry): DomainCoverage => ({
      ...entry,
      evidence: [...new Map(entry.evidence.map((evidence) => [
        JSON.stringify(evidence),
        { ...evidence },
      ])).values()].sort((left: DomainCoverageEvidence, right: DomainCoverageEvidence) =>
        left.type.localeCompare(right.type) ||
        (left.path ?? left.value).localeCompare(right.path ?? right.value) ||
        left.value.localeCompare(right.value) ||
        (left.projectId ?? "").localeCompare(right.projectId ?? "")
      ),
      modules: entry.modules
        .map((module) => {
          const scopes = boundRecords([...new Set(module.scopes)], (scope) => scope);
          const bounded = boundLimitations(module.limitations);
          return {
            ...module,
            scopes: scopes.records,
            ...(scopes.summary.omitted === 0 ? {} : { scopeSummary: scopes.summary }),
            limitations: bounded.limitations,
            ...(bounded.groups.length === 0 ? {} : { limitationGroups: bounded.groups }),
            ...(bounded.summary.omitted === 0 ? {} : { limitationSummary: bounded.summary }),
          };
        })
        .sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
      ...(() => {
        const bounded = boundLimitations(entry.limitations);
        return {
          limitations: bounded.limitations,
          ...(bounded.groups.length === 0 ? {} : { limitationGroups: bounded.groups }),
          ...(bounded.summary.omitted === 0 ? {} : { limitationSummary: bounded.summary }),
        };
      })(),
    }))
    .sort((left, right) =>
      AUDIT_DOMAINS.indexOf(left.domain) - AUDIT_DOMAINS.indexOf(right.domain)
    );

  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: VERSION },
    repository: { root },
    auditScope: normalizedAuditScope,
    projects: [...projects].sort((left, right) =>
      left.root < right.root ? -1 : left.root > right.root ? 1 : 0,
    ),
    plannedChecks: [...plannedChecks],
    domainCoverage: normalizedDomainCoverage,
    doctorRuns,
    findings,
    summary: summarizeFindings(findings),
    ...(coverage.length === 0 ? {} : { coverage }),
    ...(boundedCoverage.summary.omitted === 0
      ? {}
      : { coverageSummary: boundedCoverage.summary }),
    ...(sourceImpact === undefined ? {} : { sourceImpact: normalizeSourceImpact(sourceImpact) }),
  };
}

export function classifyScanExit(
  result: ScanResult,
  failOn: FindingThreshold,
): 0 | 1 | 2 {
  if (result.doctorRuns.some(({ status }) => status === "failed")) return 2;
  const findings = result.comparison === undefined
    ? result.findings
    : result.findings.filter(({ fingerprint }) => result.comparison?.new.includes(fingerprint));
  return hasFindingAtOrAbove(findings, failOn) ? 1 : 0;
}
