import { posix } from "node:path";
import type {
  DetectedProject,
  FileInventory,
  JsonObject,
  ManifestRecord,
  PackageManager,
  ProjectDetection,
  WorkspaceRecord,
} from "./types.js";

interface ProjectAccumulator {
  root: string;
  ecosystems: Set<string>;
  languages: Set<string>;
  frameworks: Set<string>;
  manifestPaths: Set<string>;
  packageManifest?: Extract<ManifestRecord, { status: "valid" }>;
}

const LOCKFILES: Readonly<Record<string, PackageManager>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

function directoryOf(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "." : directory;
}

function pathAtRoot(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

function projectId(root: string): string {
  return root === "." ? "root" : `project:${root}`;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function dependencyNames(manifest: Extract<ManifestRecord, { status: "valid" }>): string[] {
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    for (const name of Object.keys(objectValue(manifest.data[field]) ?? {})) {
      const normalized = nonEmptyString(name);
      if (normalized !== undefined) names.add(normalized);
    }
  }
  return [...names].sort();
}

function addProject(
  projects: Map<string, ProjectAccumulator>,
  root: string,
): ProjectAccumulator {
  const existing = projects.get(root);
  if (existing !== undefined) return existing;

  const created: ProjectAccumulator = {
    root,
    ecosystems: new Set(),
    languages: new Set(),
    frameworks: new Set(),
    manifestPaths: new Set(),
  };
  projects.set(root, created);
  return created;
}

function addNodeManifest(
  projects: Map<string, ProjectAccumulator>,
  manifest: ManifestRecord,
): void {
  const project = addProject(projects, directoryOf(manifest.path));
  project.ecosystems.add("node");
  project.languages.add("javascript");
  project.manifestPaths.add(manifest.path);
  if (manifest.status !== "valid") return;

  project.packageManifest = manifest;
  const dependencies = {
    ...objectValue(manifest.data.dependencies),
    ...objectValue(manifest.data.devDependencies),
  };
  if ("typescript" in dependencies) project.languages.add("typescript");
  if ("@nestjs/core" in dependencies) project.frameworks.add("nestjs");
  if ("next" in dependencies) project.frameworks.add("nextjs");
  if ("react" in dependencies) project.frameworks.add("react");
  if ("vite" in dependencies) project.frameworks.add("vite");
}

function addSignal(
  projects: Map<string, ProjectAccumulator>,
  path: string,
  ecosystem: string,
  language: string,
): ProjectAccumulator {
  const project = addProject(projects, directoryOf(path));
  project.ecosystems.add(ecosystem);
  project.languages.add(language);
  project.manifestPaths.add(path);
  return project;
}

function detectStaticSignals(
  projects: Map<string, ProjectAccumulator>,
  inventory: FileInventory,
): void {
  for (const file of inventory.files) {
    if (file.kind !== "file") continue;
    const name = posix.basename(file.path);

    if (/^tsconfig(?:\..+)?\.json$/.test(name)) {
      const project = addProject(projects, directoryOf(file.path));
      project.ecosystems.add("node");
      project.languages.add("javascript");
      project.languages.add("typescript");
      continue;
    }
    if (name === "pyproject.toml" || name === "setup.cfg" || name === "setup.py" ||
      /^requirements(?:[-.].*)?\.txt$/.test(name)) {
      addSignal(projects, file.path, "python", "python");
      continue;
    }
    if (name === "go.mod" || name === "go.work") {
      addSignal(projects, file.path, "go", "go");
      continue;
    }
    if (name === "Cargo.toml") {
      addSignal(projects, file.path, "rust", "rust");
      continue;
    }
    if (name === "pom.xml" || name === "build.gradle" || name === "build.gradle.kts" ||
      name === "settings.gradle" || name === "settings.gradle.kts") {
      addSignal(projects, file.path, "java", "java");
    }
  }
}

function declaredPackageManager(project: ProjectAccumulator): PackageManager | undefined {
  const declaration = project.packageManifest?.data.packageManager;
  if (typeof declaration !== "string") return undefined;
  const manager = declaration.split("@", 1)[0];
  return manager === "npm" || manager === "pnpm" || manager === "yarn" || manager === "bun"
    ? manager
    : undefined;
}

function detectedPackageManager(
  project: ProjectAccumulator,
  filePaths: ReadonlySet<string>,
): PackageManager | undefined {
  const declared = declaredPackageManager(project);
  if (declared !== undefined) return declared;

  const managers = new Set<PackageManager>();
  for (const [lockfile, manager] of Object.entries(LOCKFILES)) {
    if (filePaths.has(pathAtRoot(project.root, lockfile))) managers.add(manager);
  }
  return managers.size === 1 ? [...managers][0] : undefined;
}

function normalizeWorkspacePattern(pattern: string): string {
  const normalized = posix.normalize(pattern.replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function workspacePatterns(manifest: Extract<ManifestRecord, { status: "valid" }>): string[] {
  const workspaces = manifest.data.workspaces;
  if (Array.isArray(workspaces)) return stringArray(workspaces);
  return stringArray(objectValue(workspaces)?.packages);
}

function detectWorkspaces(projects: readonly DetectedProject[], accumulators: readonly ProjectAccumulator[]): WorkspaceRecord[] {
  const projectRoots = new Set(projects.map(({ root }) => root));
  const records: WorkspaceRecord[] = [];

  for (const owner of accumulators) {
    if (owner.packageManifest === undefined) continue;
    for (const rawPattern of workspacePatterns(owner.packageManifest)) {
      const pattern = normalizeWorkspacePattern(rawPattern);
      const wildcardIndex = pattern.indexOf("*");
      const supported = wildcardIndex === -1 ||
        (pattern.endsWith("/*") && wildcardIndex === pattern.length - 1);
      const absolutePattern = owner.root === "." ? pattern : `${owner.root}/${pattern}`;
      let matchedProjectRoots: string[] = [];

      if (supported && pattern.endsWith("/*")) {
        const parent = absolutePattern.slice(0, -2);
        matchedProjectRoots = [...projectRoots].filter((root) =>
          posix.dirname(root) === parent && root !== owner.root,
        );
      } else if (supported && projectRoots.has(absolutePattern)) {
        matchedProjectRoots = [absolutePattern];
      }

      records.push({
        ownerProjectId: projectId(owner.root),
        sourcePath: owner.packageManifest.path,
        pattern,
        supported,
        matchedProjectRoots: matchedProjectRoots.sort(),
      });
    }
  }

  return records.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath) || left.pattern.localeCompare(right.pattern),
  );
}

export async function detectProjects(
  inventory: FileInventory,
  manifests: readonly ManifestRecord[],
): Promise<ProjectDetection> {
  const accumulators = new Map<string, ProjectAccumulator>();
  for (const manifest of manifests) addNodeManifest(accumulators, manifest);
  detectStaticSignals(accumulators, inventory);

  const filePaths = new Set(inventory.files
    .filter(({ kind }) => kind === "file")
    .map(({ path }) => path));
  const projects: DetectedProject[] = [...accumulators.values()]
    .sort((left, right) => left.root.localeCompare(right.root))
    .map((project) => {
      const packageManager = detectedPackageManager(project, filePaths);
      const packageName = nonEmptyString(project.packageManifest?.data.name);
      const executionSupport = project.ecosystems.has("node") || project.ecosystems.has("python")
        ? "supported" as const
        : "detected-only" as const;
      return {
        id: projectId(project.root),
        root: project.root,
        ecosystems: [...project.ecosystems].sort(),
        languages: [...project.languages].sort(),
        frameworks: [...project.frameworks].sort(),
        ...(packageManager === undefined ? {} : { packageManager }),
        ...(project.packageManifest === undefined
          ? {}
          : {
              ...(packageName === undefined
                ? {}
                : { packageName }),
              dependencyNames: dependencyNames(project.packageManifest),
            }),
        manifestPaths: [...project.manifestPaths].sort(),
        executionSupport,
      };
    });

  return {
    projects,
    workspaces: detectWorkspaces(projects, [...accumulators.values()]),
  };
}
