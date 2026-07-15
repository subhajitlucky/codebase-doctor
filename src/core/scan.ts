import type { Doctor } from "./doctor.js";
import { normalizeScanResult, type ScanResult } from "./normalize.js";
import { runDoctors } from "./registry.js";
import type { FindingThreshold } from "./summary.js";
import { createCheckDoctor } from "../doctors/checks/doctor.js";
import { projectDoctor } from "../doctors/project/doctor.js";
import { createRlsDoctor } from "../audits/database/rls/doctor.js";
import { inventoryFiles } from "../workspace/file-inventory.js";
import { loadPackageManifests } from "../workspace/manifest-loader.js";
import { detectProjects } from "../workspace/project-detector.js";
import type { CommandPlan } from "../execution/types.js";
import { displayCommand } from "../execution/command-plan.js";
import { planChecks } from "../doctors/checks/planner.js";
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
  const dependencies: ScanDependencies = { ...defaultDependencies, ...overrides };
  const inventory = await dependencies.inventoryWorkspace(request.root, {
    exclude: request.exclude ?? [],
  });
  const manifests = await dependencies.loadManifests(inventory);
  const detection = await dependencies.detectWorkspaceProjects(inventory, manifests);
  const snapshot: ProjectSnapshot = {
    root: inventory.root,
    files: inventory.files,
    manifests,
    projects: detection.projects,
    workspaces: detection.workspaces,
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

  return normalizeScanResult(
    inventory.root,
    detection.projects,
    results,
    plans.map((plan) => ({
      planId: plan.id,
      projectId: plan.projectId,
      label: plan.label,
      command: displayCommand(plan),
    })),
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
