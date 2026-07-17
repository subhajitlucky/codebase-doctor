import type { Doctor } from "./doctor.js";
import { normalizeScanResult, type ScanResult } from "./normalize.js";
import { runDoctors } from "./registry.js";
import type { FindingThreshold } from "./summary.js";
import { createCheckDoctor } from "../doctors/checks/doctor.js";
import { projectDoctor } from "../doctors/project/doctor.js";
import { createRlsDoctor } from "../audits/database/rls/doctor.js";
import { createSqlRlsDoctor } from "../audits/database/sql-rls/doctor.js";
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
import { fullAuditScope, planChangedScope } from "../scope/planner.js";
import { planDomainCoverage } from "./domain-coverage.js";
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
  withDatabase?: boolean;
  databaseSchemas?: readonly string[];
  databaseTimeoutMs?: number;
  changed?: boolean;
  baseRef?: string;
}

export interface AuditRequest extends ScanRequest {
  includeDatabaseAudit: true;
}

export interface ScanDependencies {
  inventoryWorkspace(root: string, options?: FileInventoryOptions): Promise<FileInventory>;
  loadManifests(inventory: FileInventory): Promise<ManifestRecord[]>;
  detectWorkspaceProjects(
    inventory: FileInventory,
    manifests: readonly ManifestRecord[],
  ): Promise<ProjectDetection>;
  discoverChanges(options: DiscoverChangesOptions): Promise<DiscoveredChanges>;
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
  discoverChanges: discoverGitChanges,
  createDoctors: (request, hooks, plans) => {
    const doctors: Doctor[] = [
      projectDoctor,
      createCheckDoctor({
        timeoutMs: request.timeoutMs,
        plans,
        ...(hooks.onCommandPlan === undefined ? {} : { onPlan: hooks.onCommandPlan }),
      }),
    ];
    if (request.includeDatabaseAudit === true) {
      doctors.push(createSqlRlsDoctor());
      doctors.push(createRlsDoctor({
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
  let auditScope = fullAuditScope();
  if (request.changed === true) {
    const { base, changes } = await dependencies.discoverChanges({
      root: inventory.root,
      ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    });
    auditScope = planChangedScope(base, changes, detection.projects);
  }
  const snapshot: ProjectSnapshot = {
    root: inventory.root,
    files: inventory.files,
    manifests,
    projects: detection.projects,
    workspaces: detection.workspaces,
    auditScope,
  };
  const plans = planChecks(snapshot, request.timeoutMs);
  const results = await runDoctors(
    dependencies.createDoctors(request, hooks, plans),
    snapshot,
    {
      runChecks: request.runChecks,
      withDatabase: request.withDatabase === true,
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
  );
}

export async function auditCodebase(
  request: AuditRequest,
  overrides: Partial<ScanDependencies> = {},
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  return scanCodebase(
    { ...request, includeDatabaseAudit: true },
    overrides,
    hooks,
  );
}
