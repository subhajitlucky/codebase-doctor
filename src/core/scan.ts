import type { Doctor } from "./doctor.js";
import { normalizeScanResult, type ScanResult } from "./normalize.js";
import { runDoctors } from "./registry.js";
import type { FindingThreshold } from "./summary.js";
import { createCheckDoctor } from "../doctors/checks/doctor.js";
import { projectDoctor } from "../doctors/project/doctor.js";
import { createRlsDoctor } from "../audits/database/rls/doctor.js";
import { createRlsDriftDoctor } from "../audits/database/rls-drift/doctor.js";
import { createDrizzleDoctor } from "../audits/database/drizzle/doctor.js";
import { createSqlRlsDoctor } from "../audits/database/sql-rls/doctor.js";
import { createSecretsDoctor } from "../audits/security/secrets/doctor.js";
import { createAgentSurfaceDoctor } from "../audits/ai/agent-surface/doctor.js";
import { createDockerDoctor } from "../audits/infrastructure/docker/doctor.js";
import { createGitHubActionsDoctor } from "../audits/infrastructure/github-actions/doctor.js";
import { createAdvisoriesDoctor } from "../audits/security/advisories/doctor.js";
import { createDependenciesDoctor } from "../audits/security/dependencies/doctor.js";
import { createSecretsHistoryDoctor } from "../audits/security/secrets-history/doctor.js";
import { inventoryFiles } from "../workspace/file-inventory.js";
import { loadPackageManifests } from "../workspace/manifest-loader.js";
import { detectProjects } from "../workspace/project-detector.js";
import type { CommandPlan } from "../execution/types.js";
import { displayCommand } from "../execution/command-plan.js";
import { planChecks } from "../doctors/checks/planner.js";
import {
  discoverGitChanges,
  type DiscoverChangesOptions,
  type DiscoveredChanges,
} from "../scope/git.js";
import { discoverRepositoryFiles } from "../scope/repository-files.js";
import { fullAuditScope, planChangedScope } from "../scope/planner.js";
import { planDomainCoverage } from "./domain-coverage.js";
import { buildInventoriedSourceGraph } from "../source-graph/builder.js";
import { planSourceImpact as planSourceImpactInternal } from "../source-graph/impact.js";
import type { SourceGraph, SourceImpact } from "../source-graph/types.js";
import { sourceGraphDoctor } from "../source-graph/doctor.js";
import { sourceIntegrityDoctor } from "../source-integrity/doctor.js";
import type {
  FileInventory,
  FileInventoryOptions,
  ManifestRecord,
  ProjectDetection,
  ProjectSnapshot,
} from "../workspace/types.js";

export interface ScanRequest {
  root: string;
  runChecks: boolean;
  format: "text" | "json" | "sarif";
  timeoutMs: number;
  failOn: FindingThreshold;
  exclude?: readonly string[];
  includeDatabaseAudit?: boolean;
  includeSecurityAudit?: boolean;
  withDatabase?: boolean;
  withAdvisories?: boolean;
  databaseSchemas?: readonly string[];
  databaseTimeoutMs?: number;
  changed?: boolean;
  baseRef?: string;
}

export interface AuditRequest extends ScanRequest {
  includeDatabaseAudit: true;
  includeSecurityAudit: true;
}

export interface ScanDependencies {
  inventoryWorkspace(root: string, options?: FileInventoryOptions): Promise<FileInventory>;
  loadManifests(inventory: FileInventory): Promise<ManifestRecord[]>;
  detectWorkspaceProjects(
    inventory: FileInventory,
    manifests: readonly ManifestRecord[],
  ): Promise<ProjectDetection>;
  buildSourceGraph(
    inventory: FileInventory,
    manifests: readonly ManifestRecord[],
    projects: ProjectDetection["projects"],
  ): Promise<SourceGraph>;
  planSourceImpact(
    mode: "full" | "changed",
    changes: DiscoveredChanges["changes"],
    graph: SourceGraph,
  ): SourceImpact;
  discoverChanges(options: DiscoverChangesOptions): Promise<DiscoveredChanges>;
  discoverRepositoryFiles(root: string): ReturnType<typeof discoverRepositoryFiles>;
  createDoctors(
    request: ScanRequest,
    hooks: ScanHooks,
    plans: readonly CommandPlan[],
  ): readonly Doctor[];
}

export interface ScanHooks {
  onCommandPlan?: (plan: CommandPlan) => void;
}

const defaultDependencies: ScanDependencies = {
  inventoryWorkspace: inventoryFiles,
  loadManifests: loadPackageManifests,
  detectWorkspaceProjects: detectProjects,
  buildSourceGraph: buildInventoriedSourceGraph,
  planSourceImpact: planSourceImpactInternal,
  discoverChanges: discoverGitChanges,
  discoverRepositoryFiles,
  createDoctors: (request, hooks, plans) => {
    const doctors: Doctor[] = [
      projectDoctor,
      sourceGraphDoctor,
      sourceIntegrityDoctor,
      createAgentSurfaceDoctor(),
      createDockerDoctor(),
      createGitHubActionsDoctor(),
      createCheckDoctor({
        timeoutMs: request.timeoutMs,
        plans,
        ...(hooks.onCommandPlan === undefined ? {} : { onPlan: hooks.onCommandPlan }),
      }),
    ];
    if (request.includeSecurityAudit === true) {
      doctors.push(createSecretsDoctor());
      doctors.push(createSecretsHistoryDoctor());
      doctors.push(createDependenciesDoctor());
      // Advisory lookup is an optional network add-on: only an explicit
      // --with-advisories request adds the module, so an unrequested lookup
      // never marks the security domain incomplete.
      if (request.withAdvisories === true) {
        doctors.push(createAdvisoriesDoctor());
      }
    }
    if (request.includeDatabaseAudit === true) {
      doctors.push(createDrizzleDoctor());
      doctors.push(createSqlRlsDoctor());
      doctors.push(createRlsDoctor({
        schemas: request.databaseSchemas ?? ["public"],
        statementTimeoutMs: request.databaseTimeoutMs ?? 10_000,
      }));
      doctors.push(createRlsDriftDoctor({
        schemas: request.databaseSchemas ?? ["public"],
        statementTimeoutMs: request.databaseTimeoutMs ?? 10_000,
      }));
    }
    return doctors;
  },
};

export async function scanCodebase(
  request: ScanRequest,
  overrides: Partial<ScanDependencies> = {},
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  if (request.baseRef !== undefined && request.changed !== true) {
    throw new Error("baseRef can only be used when changed is true.");
  }
  const dependencies: ScanDependencies = { ...defaultDependencies, ...overrides };
  const inventory = await dependencies.inventoryWorkspace(request.root, {
    exclude: request.exclude ?? [],
  });
  const manifests = await dependencies.loadManifests(inventory);
  const detection = await dependencies.detectWorkspaceProjects(inventory, manifests);
  const sourceGraph = await dependencies.buildSourceGraph(
    inventory,
    manifests,
    detection.projects,
  );
  const repositoryFiles = request.includeSecurityAudit === true && request.changed !== true
    ? await dependencies.discoverRepositoryFiles(inventory.root)
    : undefined;
  let auditScope = fullAuditScope();
  let sourceImpact: SourceImpact;
  if (request.changed === true) {
    const { base, changes } = await dependencies.discoverChanges({
      root: inventory.root,
      ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    });
    sourceImpact = dependencies.planSourceImpact("changed", changes, sourceGraph);
    auditScope = planChangedScope(base, changes, detection.projects, sourceImpact);
  } else {
    sourceImpact = dependencies.planSourceImpact("full", [], sourceGraph);
  }
  const snapshot: ProjectSnapshot = {
    root: inventory.root,
    files: inventory.files,
    manifests,
    projects: detection.projects,
    workspaces: detection.workspaces,
    auditScope,
    sourceGraph,
    sourceImpact,
    ...(repositoryFiles === undefined ? {} : { repositoryFiles }),
  };
  const plans = planChecks(snapshot, request.timeoutMs);
  const results = await runDoctors(
    dependencies.createDoctors(request, hooks, plans),
    snapshot,
    {
      runChecks: request.runChecks,
      withDatabase: request.withDatabase === true,
      withAdvisories: request.withAdvisories === true,
    },
  );
  const domainCoverage = planDomainCoverage({
    snapshot,
    registeredResults: results,
    plans,
    includeDatabaseAudit: request.includeDatabaseAudit === true,
  });

  return normalizeScanResult(
    inventory.root,
    detection.projects,
    auditScope,
    results,
    plans.map((plan) => ({
      planId: plan.id,
      projectId: plan.projectId,
      label: plan.label,
      command: displayCommand(plan),
    })),
    domainCoverage,
    sourceImpact,
  );
}

export async function auditCodebase(
  request: AuditRequest,
  overrides: Partial<ScanDependencies> = {},
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  return scanCodebase(
    { ...request, includeDatabaseAudit: true, includeSecurityAudit: true },
    overrides,
    hooks,
  );
}
