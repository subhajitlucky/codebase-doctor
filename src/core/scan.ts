import type { Doctor } from "./doctor.js";
import { normalizeScanResult, type ScanResult } from "./normalize.js";
import { runDoctors } from "./registry.js";
import type { FindingThreshold } from "./summary.js";
import { createCheckDoctor } from "../doctors/checks/doctor.js";
import { projectDoctor } from "../doctors/project/doctor.js";
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
  createDoctors: (request, hooks, plans) => [
    projectDoctor,
    createCheckDoctor({
      timeoutMs: request.timeoutMs,
      plans,
      ...(hooks.onCommandPlan === undefined ? {} : { onPlan: hooks.onCommandPlan }),
    }),
  ],
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
    { runChecks: request.runChecks },
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
