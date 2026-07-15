import { join } from "node:path";
import { createCommandPlan } from "../../execution/command-plan.js";
import type { CommandPlan } from "../../execution/types.js";
import type {
  DetectedProject,
  JsonObject,
  ManifestRecord,
  PackageManager,
  ProjectSnapshot,
} from "../../workspace/types.js";

const EXECUTABLES: Readonly<Record<PackageManager, string>> = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn",
  bun: "bun",
};

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function packageManifest(
  project: DetectedProject,
  manifests: readonly ManifestRecord[],
): Extract<ManifestRecord, { status: "valid" }> | undefined {
  return manifests.find((manifest): manifest is Extract<ManifestRecord, { status: "valid" }> =>
    manifest.status === "valid" && project.manifestPaths.includes(manifest.path),
  );
}

function selectedScripts(scripts: JsonObject): string[] {
  const first = typeof scripts.typecheck === "string"
    ? "typecheck"
    : typeof scripts.check === "string" ? "check" : undefined;
  return [first, "test", "lint", "build"].filter((name): name is string =>
    name !== undefined && typeof scripts[name] === "string",
  );
}

export function planJavaScriptChecks(
  snapshot: ProjectSnapshot,
  timeoutMs: number,
): CommandPlan[] {
  const plans: CommandPlan[] = [];

  for (const project of snapshot.projects) {
    if (!project.ecosystems.includes("node") || project.packageManager === undefined) continue;
    const manifest = packageManifest(project, snapshot.manifests);
    const scripts = objectValue(manifest?.data.scripts);
    if (scripts === undefined) continue;

    for (const script of selectedScripts(scripts)) {
      plans.push(createCommandPlan({
        id: `${project.id}:javascript:${script}`,
        projectId: project.id,
        label: `JavaScript ${script}`,
        executable: EXECUTABLES[project.packageManager],
        args: ["run", script],
        cwd: project.root === "."
          ? snapshot.root
          : join(snapshot.root, ...project.root.split("/")),
        timeoutMs,
      }));
    }
  }

  return plans;
}
