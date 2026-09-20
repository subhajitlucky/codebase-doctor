import type { RegisteredDoctorResult } from "./doctor.js";
import type { CommandPlan } from "../execution/types.js";
import type { ProjectSnapshot } from "../workspace/types.js";
import type {
  LimitationGroup,
  OmittedRecordSummary,
} from "./bounded-evidence.js";
import {
  MAX_COVERAGE_RECORDS,
  MAX_LIMITATION_SAMPLE_PATHS,
  mergeOmittedRecordSummaries,
  saturatingAddCount,
} from "./bounded-evidence.js";

export const AUDIT_DOMAINS = [
  "repository",
  "validation",
  "frontend",
  "backend",
  "database",
  "security",
  "infrastructure",
  "performance",
  "ai",
] as const;

export type AuditDomain = (typeof AUDIT_DOMAINS)[number];

export type DomainApplicability = "detected" | "not-detected" | "unknown";

export type DomainCoverageStatus =
  | "completed"
  | "partial"
  | "not-applicable"
  | "unsupported"
  | "skipped"
  | "failed"
  | "not-selected";

export interface DomainCoverageEvidence {
  type: "framework" | "language" | "ecosystem" | "dependency" | "file" | "module";
  value: string;
  path?: string;
  projectId?: string;
}

export interface DomainModuleCoverage {
  moduleId: string;
  status: DomainCoverageStatus;
  scopes: readonly string[];
  scopeSummary?: OmittedRecordSummary;
  limitations: readonly string[];
  limitationGroups?: readonly LimitationGroup[];
  limitationSummary?: OmittedRecordSummary;
}

export interface DomainCoverage {
  domain: AuditDomain;
  applicability: DomainApplicability;
  status: DomainCoverageStatus;
  coverageComplete: boolean;
  evidence: readonly DomainCoverageEvidence[];
  modules: readonly DomainModuleCoverage[];
  limitations: readonly string[];
  limitationGroups?: readonly LimitationGroup[];
  limitationSummary?: OmittedRecordSummary;
}

export interface DomainCoveragePlanningInput {
  snapshot: ProjectSnapshot;
  registeredResults: readonly RegisteredDoctorResult[];
  plans: readonly CommandPlan[];
  includeDatabaseAudit: boolean;
}

const FRONTEND_FRAMEWORKS = new Set(["nextjs", "react", "vite"]);
const BACKEND_FRAMEWORKS = new Set(["nestjs"]);

const STATUS_PRIORITY: Record<DomainCoverageStatus, number> = {
  failed: 7,
  partial: 6,
  unsupported: 5,
  skipped: 4,
  "not-selected": 3,
  completed: 2,
  "not-applicable": 1,
};

function domainForDoctor(doctorId: string): AuditDomain | undefined {
  if (doctorId === "project") return "repository";
  if (doctorId === "checks") return "validation";
  const [domain] = doctorId.split("/");
  return AUDIT_DOMAINS.includes(domain as AuditDomain) ? domain as AuditDomain : undefined;
}

function aggregateStatuses(statuses: readonly DomainCoverageStatus[]): DomainCoverageStatus {
  if (statuses.length === 0) return "not-applicable";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("partial")) return "partial";
  if (
    statuses.includes("completed") &&
    statuses.some((status) => ["unsupported", "skipped", "not-selected"].includes(status))
  ) {
    return "partial";
  }
  return [...statuses].sort((left, right) => STATUS_PRIORITY[right] - STATUS_PRIORITY[left])[0]!;
}

function aggregateLimitationMetadata(
  entries: readonly {
    limitationGroups?: readonly LimitationGroup[];
    limitationSummary?: OmittedRecordSummary;
  }[],
): {
  limitationGroups?: readonly LimitationGroup[];
  limitationSummary?: OmittedRecordSummary;
} {
  interface MutableGroup {
    reason: string;
    total: number;
    samplePaths: string[];
    omittedPathCount: number;
    summarylessTotal: number;
    summarylessSamplePaths: string[];
  }
  const groupsByReason = new Map<string, MutableGroup>();
  let limitationSummary: OmittedRecordSummary | undefined;
  let summarylessTotal = 0;

  const admitSample = (samples: string[], path: string): void => {
    if (samples.includes(path)) return;
    const insertion = samples.findIndex((sample) => path.localeCompare(sample) < 0);
    if (insertion < 0) samples.push(path);
    else samples.splice(insertion, 0, path);
    if (samples.length > MAX_LIMITATION_SAMPLE_PATHS) samples.pop();
  };

  for (const entry of entries) {
    const hasUpstreamSummary = entry.limitationSummary !== undefined;
    limitationSummary = mergeOmittedRecordSummaries(
      limitationSummary,
      entry.limitationSummary,
    );
    for (const incoming of entry.limitationGroups ?? []) {
      if (typeof incoming.reason !== "string") continue;
      const incomingTotal = saturatingAddCount(0, incoming.total);
      if (!hasUpstreamSummary) {
        summarylessTotal = saturatingAddCount(summarylessTotal, incomingTotal);
      }
      let group = groupsByReason.get(incoming.reason);
      if (group === undefined) {
        if (groupsByReason.size >= MAX_COVERAGE_RECORDS) {
          let greatestReason: string | undefined;
          for (const reason of groupsByReason.keys()) {
            if (greatestReason === undefined || reason.localeCompare(greatestReason) > 0) {
              greatestReason = reason;
            }
          }
          if (greatestReason !== undefined && incoming.reason.localeCompare(greatestReason) >= 0) {
            continue;
          }
          if (greatestReason !== undefined) groupsByReason.delete(greatestReason);
        }
        group = {
          reason: incoming.reason,
          total: 0,
          samplePaths: [],
          omittedPathCount: 0,
          summarylessTotal: 0,
          summarylessSamplePaths: [],
        };
        groupsByReason.set(incoming.reason, group);
      }
      group.total = saturatingAddCount(group.total, incomingTotal);
      group.omittedPathCount = saturatingAddCount(
        group.omittedPathCount,
        incoming.omittedPathCount,
      );
      for (const path of incoming.samplePaths) {
        if (typeof path !== "string") continue;
        admitSample(group.samplePaths, path);
        if (!hasUpstreamSummary) admitSample(group.summarylessSamplePaths, path);
      }
      if (!hasUpstreamSummary) {
        group.summarylessTotal = saturatingAddCount(
          group.summarylessTotal,
          incomingTotal,
        );
      }
    }
  }
  let summarylessEmitted = 0;
  for (const group of groupsByReason.values()) {
    summarylessEmitted = saturatingAddCount(
      summarylessEmitted,
      Math.min(group.summarylessTotal, group.summarylessSamplePaths.length),
    );
  }
  if (summarylessTotal > 0) {
    limitationSummary = mergeOmittedRecordSummaries(limitationSummary, {
      total: summarylessTotal,
      emitted: summarylessEmitted,
      omitted: summarylessTotal - summarylessEmitted,
    });
  }
  const groups = [...groupsByReason.values()]
    .sort((left, right) => left.reason.localeCompare(right.reason))
    .map((group): LimitationGroup => ({
      reason: group.reason,
      total: group.total,
      samplePaths: group.samplePaths,
      omittedPathCount: Math.max(
        group.omittedPathCount,
        Math.max(0, group.total - group.samplePaths.length),
      ),
    }));
  return {
    ...(groups.length === 0 ? {} : { limitationGroups: groups }),
    ...(limitationSummary === undefined ? {} : { limitationSummary }),
  };
}

function moduleCoverage(entry: RegisteredDoctorResult): DomainModuleCoverage {
  const coverage = entry.result.coverage ?? [];
  const status = entry.result.status === "failed"
    ? "failed"
    : entry.result.status === "skipped"
      ? "skipped"
      : coverage.length === 0
        ? "completed"
        : aggregateStatuses(coverage.map(({ status }) => status));
  const scopes = [...new Set(coverage.map(({ scope }) => scope))].sort();
  const limitations = [...new Set([
    ...coverage.flatMap(({ limitations }) => limitations),
    ...(entry.result.skipReason === undefined ? [] : [entry.result.skipReason]),
    ...(entry.result.error === undefined ? [] : [entry.result.error.message]),
  ])].sort();
  return {
    moduleId: entry.doctorId,
    status,
    scopes,
    limitations,
    ...aggregateLimitationMetadata(coverage),
  };
}

function evidenceKey(evidence: DomainCoverageEvidence): string {
  return JSON.stringify([
    evidence.type,
    evidence.path ?? "",
    evidence.value,
    evidence.projectId ?? "",
  ]);
}

function sortEvidence(evidence: readonly DomainCoverageEvidence[]): DomainCoverageEvidence[] {
  const unique = new Map(evidence.map((entry) => [evidenceKey(entry), { ...entry }]));
  return [...unique.values()].sort((left, right) =>
    left.type.localeCompare(right.type) ||
    (left.path ?? left.value).localeCompare(right.path ?? right.value) ||
    left.value.localeCompare(right.value) ||
    (left.projectId ?? "").localeCompare(right.projectId ?? "")
  );
}

function frameworkEvidence(
  snapshot: ProjectSnapshot,
  frameworks: ReadonlySet<string>,
): DomainCoverageEvidence[] {
  return sortEvidence(snapshot.projects.flatMap((project) =>
    project.frameworks
      .filter((framework) => frameworks.has(framework.toLowerCase()))
      .map((framework) => ({
        type: "framework" as const,
        value: framework.toLowerCase(),
        projectId: project.id,
      }))
  ));
}

function infrastructureEvidence(snapshot: ProjectSnapshot): DomainCoverageEvidence[] {
  return sortEvidence(snapshot.files.flatMap(({ path }) => {
    const lower = path.toLowerCase();
    if (lower === "dockerfile" || lower.endsWith("/dockerfile") || lower.endsWith(".dockerfile")) {
      return [{ type: "file" as const, value: "docker", path }];
    }
    if (lower.startsWith(".github/workflows/") && /\.ya?ml$/.test(lower)) {
      return [{ type: "file" as const, value: "github-actions", path }];
    }
    if (lower === "vercel.json" || lower.endsWith("/vercel.json")) {
      return [{ type: "file" as const, value: "vercel", path }];
    }
    if (
      lower === "railway.json" || lower === "railway.toml" ||
      lower.endsWith("/railway.json") || lower.endsWith("/railway.toml")
    ) {
      return [{ type: "file" as const, value: "railway", path }];
    }
    return [];
  }));
}

function isAiDependency(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "openai" ||
    lower === "@anthropic-ai/sdk" ||
    lower === "ai" ||
    lower.startsWith("@ai-sdk/") ||
    lower === "langchain" ||
    lower.startsWith("@langchain/") ||
    lower === "llamaindex" ||
    lower.startsWith("@llamaindex/");
}

function aiEvidence(snapshot: ProjectSnapshot): DomainCoverageEvidence[] {
  return sortEvidence(snapshot.projects.flatMap((project) =>
    (project.dependencyNames ?? [])
      .filter(isAiDependency)
      .map((dependency) => ({
        type: "dependency" as const,
        value: dependency,
        projectId: project.id,
      }))
  ));
}

function unsupportedEntry(
  domain: AuditDomain,
  evidence: readonly DomainCoverageEvidence[],
  limitation: string,
): DomainCoverage {
  const detected = evidence.length > 0;
  return {
    domain,
    applicability: detected ? "detected" : "not-detected",
    status: detected ? "unsupported" : "not-applicable",
    coverageComplete: !detected,
    evidence: sortEvidence(evidence),
    modules: [],
    limitations: detected ? [limitation] : [],
  };
}

function isDomainSelectedInChangedScope(
  entry: DomainCoverage,
  snapshot: ProjectSnapshot,
): boolean {
  if (snapshot.auditScope.mode === "full") return true;
  if (entry.domain === "repository" || entry.domain === "database") return true;
  if (entry.domain === "validation") return entry.evidence.length > 0;
  if (entry.domain === "security" || entry.domain === "performance") {
    return snapshot.auditScope.changes.length > 0 ||
      snapshot.auditScope.affectedProjectIds.length > 0;
  }
  const affectedProjects = new Set(snapshot.auditScope.affectedProjectIds);
  const changedPaths = new Set(snapshot.auditScope.changes.flatMap((change) => [
    change.path,
    ...(change.previousPath === undefined ? [] : [change.previousPath]),
  ]));
  return entry.evidence.some((evidence) =>
    (evidence.projectId !== undefined && affectedProjects.has(evidence.projectId)) ||
    (evidence.path !== undefined && changedPaths.has(evidence.path))
  );
}

function applyChangedSelection(
  entry: DomainCoverage,
  snapshot: ProjectSnapshot,
): DomainCoverage {
  if (
    snapshot.auditScope.mode === "full" ||
    entry.status === "not-selected" ||
    entry.status === "not-applicable" ||
    isDomainSelectedInChangedScope(entry, snapshot)
  ) {
    return entry;
  }
  return {
    ...entry,
    status: "not-selected",
    coverageComplete: false,
    limitations: [...new Set([
      ...entry.limitations,
      "This domain was outside the selected changed scope.",
    ])].sort(),
  };
}

function aiCoverage(
  modules: readonly DomainModuleCoverage[],
  snapshot: ProjectSnapshot,
): DomainCoverage {
  if (modules.length === 0) {
    return unsupportedEntry(
      "ai",
      aiEvidence(snapshot),
      "AI SDK evidence was detected, but semantic AI-system analysis is not implemented.",
    );
  }

  const status = aggregateStatuses(modules.map(({ status }) => status));
  const applicability = status === "not-applicable" ? "not-detected" : "detected";
  return {
    domain: "ai",
    applicability,
    status,
    coverageComplete: status === "completed" || status === "not-applicable",
    evidence: sortEvidence([
      ...aiEvidence(snapshot),
      ...modules.map(({ moduleId }) => ({
        type: "module" as const,
        value: moduleId,
      })),
    ]),
    modules,
    limitations: [...new Set(modules.flatMap(({ limitations }) => limitations))].sort(),
  };
}

function infrastructureCoverage(
  modules: readonly DomainModuleCoverage[],
  snapshot: ProjectSnapshot,
): DomainCoverage {
  const status = aggregateStatuses(modules.map(({ status }) => status));
  const applicability = status === "not-applicable" ? "not-detected" : "detected";
  return {
    domain: "infrastructure",
    applicability,
    status,
    coverageComplete: status === "completed" || status === "not-applicable",
    evidence: sortEvidence([
      ...infrastructureEvidence(snapshot),
      ...modules.map(({ moduleId }) => ({
        type: "module" as const,
        value: moduleId,
      })),
    ]),
    modules,
    limitations: [...new Set(modules.flatMap(({ limitations }) => limitations))].sort(),
  };
}

function securityCoverage(
  modules: readonly DomainModuleCoverage[],
  snapshot: ProjectSnapshot,
): DomainCoverage {
  if (modules.length === 0) {
    return {
      domain: "security",
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
      evidence: [],
      modules: [],
      limitations: ["General security applicability and semantic analysis are not implemented."],
    };
  }

  const moduleStatus = aggregateStatuses(modules.map(({ status }) => status));
  const emptyChangedSelection = snapshot.auditScope.mode === "changed" &&
    snapshot.auditScope.changes.length === 0 &&
    moduleStatus === "not-applicable";
  const status = emptyChangedSelection ? "not-selected" : moduleStatus;
  const applicability = status === "not-selected"
    ? "unknown"
    : status === "not-applicable" ? "not-detected" : "detected";
  const limitations = emptyChangedSelection
    ? ["No current changed file was selected for secrets analysis."]
    : modules.flatMap(({ limitations: moduleLimitations }) => moduleLimitations);
  return {
    domain: "security",
    applicability,
    status,
    coverageComplete: status === "completed" || status === "not-applicable",
    evidence: sortEvidence(modules.map(({ moduleId }) => ({
      type: "module" as const,
      value: moduleId,
    }))),
    modules,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function planDomainCoverage(
  input: DomainCoveragePlanningInput,
): DomainCoverage[] {
  const modulesByDomain = new Map<AuditDomain, DomainModuleCoverage[]>();
  for (const result of input.registeredResults) {
    const domain = domainForDoctor(result.doctorId);
    if (domain === undefined) continue;
    const modules = modulesByDomain.get(domain) ?? [];
    modules.push(moduleCoverage(result));
    modulesByDomain.set(domain, modules);
  }
  for (const modules of modulesByDomain.values()) {
    modules.sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  }

  const frontend = unsupportedEntry(
    "frontend",
    frameworkEvidence(input.snapshot, FRONTEND_FRAMEWORKS),
    "Frontend framework evidence was detected, but semantic frontend analysis is not implemented.",
  );
  const backend = unsupportedEntry(
    "backend",
    frameworkEvidence(input.snapshot, BACKEND_FRAMEWORKS),
    "Backend framework evidence was detected, but semantic backend analysis is not implemented.",
  );
  const infrastructure =
    (modulesByDomain.get("infrastructure") ?? []).length === 0
      ? unsupportedEntry(
          "infrastructure",
          infrastructureEvidence(input.snapshot),
          "Infrastructure configuration was detected, but semantic infrastructure analysis is not implemented.",
        )
      : infrastructureCoverage(modulesByDomain.get("infrastructure")!, input.snapshot);
  const ai =
    (modulesByDomain.get("ai") ?? []).length === 0
      ? unsupportedEntry(
          "ai",
          aiEvidence(input.snapshot),
          "AI SDK evidence was detected, but semantic AI-system analysis is not implemented.",
        )
      : aiCoverage(modulesByDomain.get("ai")!, input.snapshot);

  const repositoryModules = modulesByDomain.get("repository") ?? [];
  const repositoryStatus = aggregateStatuses(repositoryModules.map(({ status }) => status));
  const validationModules = modulesByDomain.get("validation") ?? [];
  const validationDetected = input.plans.length > 0;
  const validationStatus = validationDetected
    ? aggregateStatuses(validationModules.map(({ status }) => status))
    : "not-applicable";
  const databaseModules = modulesByDomain.get("database") ?? [];
  const securityModules = modulesByDomain.get("security") ?? [];
  const databaseStatus = input.includeDatabaseAudit
    ? aggregateStatuses(databaseModules.map(({ status }) => status))
    : "not-selected";
  const databaseDetected = databaseModules.some((module) =>
    module.status === "completed" || module.status === "partial"
  );
  const databaseLimitationMetadata = aggregateLimitationMetadata(databaseModules);

  const coverage: DomainCoverage[] = [
    {
      domain: "repository",
      applicability: "detected",
      status: repositoryStatus,
      coverageComplete: repositoryStatus === "completed",
      evidence: sortEvidence(repositoryModules.map(({ moduleId }) => ({
        type: "module" as const,
        value: moduleId,
      }))),
      modules: repositoryModules,
      limitations: repositoryModules.flatMap(({ limitations }) => limitations),
    },
    {
      domain: "validation",
      applicability: validationDetected ? "detected" : "not-detected",
      status: validationStatus,
      coverageComplete: validationStatus === "completed" || validationStatus === "not-applicable",
      evidence: sortEvidence(input.plans.map((plan) => ({
        type: "module" as const,
        value: plan.id,
        projectId: plan.projectId,
      }))),
      modules: validationDetected ? validationModules : [],
      limitations: validationDetected
        ? validationModules.flatMap(({ limitations }) => limitations)
        : [],
    },
    frontend,
    backend,
    {
      domain: "database",
      applicability: databaseDetected ? "detected" : "unknown",
      status: databaseStatus,
      coverageComplete: databaseStatus === "completed" || databaseStatus === "not-applicable",
      evidence: sortEvidence(databaseModules.map(({ moduleId }) => ({
        type: "module" as const,
        value: moduleId,
      }))),
      modules: databaseModules,
      limitations: input.includeDatabaseAudit
        ? databaseModules.flatMap(({ limitations }) => limitations)
        : ["The repository-only scan command does not select database audit modules."],
      ...(input.includeDatabaseAudit ? databaseLimitationMetadata : {}),
    },
    securityCoverage(securityModules, input.snapshot),
    infrastructure,
    {
      domain: "performance",
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
      evidence: [],
      modules: [],
      limitations: ["Performance applicability and semantic analysis are not implemented."],
    },
    ai,
  ];
  return coverage.map((entry) => applyChangedSelection(entry, input.snapshot));
}
