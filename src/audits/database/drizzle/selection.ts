import type {
  DetectedProject,
  FileRecord,
  ManifestRecord,
  ProjectSnapshot,
} from "../../../workspace/types.js";

export const DEFAULT_MAX_DRIZZLE_FILES = 10_000;
export const DEFAULT_MAX_DRIZZLE_SELECTION_LIMITATIONS = 100;

const SUPPORTED_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/iu;
const DRIZZLE_DEPENDENCY = "drizzle-orm";
const POSTGRES_JS_DEPENDENCY = "postgres";

export interface DrizzleSelectionOptions {
  readonly maxFiles?: number;
  readonly maxLimitations?: number;
  /**
   * Inventoried paths for which a parser has already proven an exact
   * `drizzle-orm/postgres-js` module import. Selection deliberately accepts
   * bounded evidence instead of reading or parsing target source itself.
   */
  readonly postgresJsImportPaths?: readonly string[];
}

export interface DrizzleAuditFileSelection {
  readonly scope: "full" | "changed";
  readonly applicableProjectIds: readonly string[];
  readonly files: readonly FileRecord[];
  readonly limitations: readonly string[];
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function supportsSource(path: string): boolean {
  return SUPPORTED_SOURCE_EXTENSION.test(path);
}

function containsPath(project: DetectedProject, path: string): boolean {
  return project.root === "." || path === project.root || path.startsWith(`${project.root}/`);
}

function projectDepth(project: DetectedProject): number {
  return project.root === "." ? 0 : project.root.split("/").length;
}

function uniqueOwner(
  path: string,
  projects: readonly DetectedProject[],
): DetectedProject | "ambiguous" | undefined {
  const candidates = projects
    .filter((project) => containsPath(project, path))
    .sort((left, right) =>
      projectDepth(right) - projectDepth(left) ||
      left.root.localeCompare(right.root) ||
      left.id.localeCompare(right.id)
  );
  if (candidates.length === 0) return undefined;
  const deepestCandidate = candidates[0];
  if (deepestCandidate === undefined) return undefined;
  const depth = projectDepth(deepestCandidate);
  const deepest = candidates.filter((project) => projectDepth(project) === depth);
  return deepest.length === 1 ? deepest[0] : "ambiguous";
}

function manifestDependencyNames(manifest: ManifestRecord): readonly string[] {
  if (manifest.status !== "valid") return [];
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest.data[field];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) names.add(name);
  }
  return [...names];
}

function dependencyIndex(snapshot: ProjectSnapshot): ReadonlyMap<string, ReadonlySet<string>> {
  const manifestsByPath = new Map(snapshot.manifests.map((manifest) => [manifest.path, manifest]));
  return new Map(snapshot.projects.map((project) => {
    const names = new Set(project.dependencyNames ?? []);
    for (const path of project.manifestPaths) {
      const manifest = manifestsByPath.get(path);
      if (manifest === undefined) continue;
      for (const name of manifestDependencyNames(manifest)) names.add(name);
    }
    return [project.id, names] as const;
  }));
}

function workspaceContextProjectIds(
  project: DetectedProject,
  snapshot: ProjectSnapshot,
): ReadonlySet<string> {
  const projectsById = new Map(snapshot.projects.map((candidate) => [candidate.id, candidate]));
  const context = new Set([project.id]);
  const queue = [project.root];
  while (queue.length > 0) {
    const root = queue.shift();
    if (root === undefined) break;
    for (const workspace of snapshot.workspaces) {
      if (!workspace.supported || !workspace.matchedProjectRoots.includes(root)) continue;
      if (context.has(workspace.ownerProjectId)) continue;
      const owner = projectsById.get(workspace.ownerProjectId);
      if (owner === undefined) continue;
      context.add(owner.id);
      queue.push(owner.root);
    }
  }
  return context;
}

function dependencyApplicable(
  project: DetectedProject,
  snapshot: ProjectSnapshot,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const combined = new Set<string>();
  for (const projectId of workspaceContextProjectIds(project, snapshot)) {
    for (const dependency of dependencies.get(projectId) ?? []) combined.add(dependency);
  }
  return combined.has(DRIZZLE_DEPENDENCY) && combined.has(POSTGRES_JS_DEPENDENCY);
}

function boundedLimitations(values: ReadonlySet<string>, max: number): readonly string[] {
  const ordered = [...values].sort();
  if (ordered.length <= max) return ordered;
  const omitted = ordered.length - max;
  return [
    ...ordered.slice(0, max),
    `Drizzle source selection omitted ${omitted} additional limitation${omitted === 1 ? "" : "s"}.`,
  ];
}

export function selectDrizzleAuditFiles(
  snapshot: ProjectSnapshot,
  options: DrizzleSelectionOptions = {},
): DrizzleAuditFileSelection {
  const maxFiles = positiveSafeInteger(
    options.maxFiles ?? DEFAULT_MAX_DRIZZLE_FILES,
    "maxFiles",
  );
  const maxLimitations = positiveSafeInteger(
    options.maxLimitations ?? DEFAULT_MAX_DRIZZLE_SELECTION_LIMITATIONS,
    "maxLimitations",
  );
  const scope = snapshot.auditScope.mode;
  const limitations = new Set<string>();
  const filesByPath = new Map(snapshot.files.map((entry) => [entry.path, entry]));
  const dependencies = dependencyIndex(snapshot);
  const affected = new Set(snapshot.auditScope.affectedProjectIds);
  const sourceProvenProjectIds = new Set<string>();

  for (const path of [...new Set(options.postgresJsImportPaths ?? [])].sort()) {
    const file = filesByPath.get(path);
    if (file?.kind !== "file") {
      limitations.add(`${path}: postgres-js import evidence is not an inventoried regular file.`);
      continue;
    }
    if (!supportsSource(path)) {
      limitations.add(`${path}: postgres-js import evidence is outside supported source selection.`);
      continue;
    }
    const owner = uniqueOwner(path, snapshot.projects);
    if (owner === undefined || owner === "ambiguous") {
      limitations.add(`${path}: postgres-js import evidence has no unambiguous project owner.`);
      continue;
    }
    sourceProvenProjectIds.add(owner.id);
  }

  const applicableProjects = snapshot.projects
    .filter((project) => scope === "full" || affected.has(project.id))
    .filter((project) =>
      sourceProvenProjectIds.has(project.id) ||
      dependencyApplicable(project, snapshot, dependencies)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const applicableProjectIds = new Set(applicableProjects.map(({ id }) => id));

  for (const workspace of snapshot.workspaces) {
    if (workspace.supported) continue;
    for (const matchedRoot of workspace.matchedProjectRoots) {
      const project = snapshot.projects.find((candidate) => candidate.root === matchedRoot);
      if (project === undefined || (scope === "changed" && !affected.has(project.id))) continue;
      if (applicableProjectIds.has(project.id)) continue;
      const ownDependencies = dependencies.get(project.id) ?? new Set<string>();
      if (
        ownDependencies.has(DRIZZLE_DEPENDENCY) ||
        ownDependencies.has(POSTGRES_JS_DEPENDENCY)
      ) {
        limitations.add(
          `${project.root}: unsupported workspace ownership prevents complete Drizzle applicability analysis.`,
        );
      }
    }
  }

  const selected: FileRecord[] = [];
  if (scope === "full") {
    for (const file of snapshot.files) {
      if (file.kind !== "file" || !supportsSource(file.path)) continue;
      const owner = uniqueOwner(file.path, snapshot.projects);
      if (owner === "ambiguous") {
        const candidates = snapshot.projects.filter((project) =>
          containsPath(project, file.path) && applicableProjectIds.has(project.id)
        );
        if (candidates.length > 0) {
          limitations.add(
            `${file.path}: source ownership is ambiguous; Drizzle analysis was withheld.`,
          );
        }
        continue;
      }
      if (owner !== undefined && applicableProjectIds.has(owner.id)) selected.push(file);
    }
  } else {
    for (const change of snapshot.auditScope.changes) {
      if (change.status === "deleted") {
        if (supportsSource(change.path)) {
          limitations.add(`${change.path}: deleted changed source could not be examined.`);
        }
        continue;
      }
      const file = filesByPath.get(change.path);
      if (file?.kind !== "file") {
        limitations.add(`${change.path}: changed path is not an inventoried regular file.`);
        continue;
      }
      if (!supportsSource(change.path)) {
        limitations.add(
          `${change.path}: changed path is not a supported JavaScript or TypeScript source file.`,
        );
        continue;
      }
      const owner = uniqueOwner(change.path, snapshot.projects);
      if (owner === undefined || owner === "ambiguous") {
        limitations.add(`${change.path}: changed source has no unambiguous project owner.`);
        continue;
      }
      if (!applicableProjectIds.has(owner.id)) {
        limitations.add(
          `${change.path}: changed source is outside an applicable affected Drizzle project.`,
        );
        continue;
      }
      selected.push(file);
    }
  }

  const orderedFiles = [...new Map(selected.map((file) => [file.path, file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const omittedFiles = Math.max(orderedFiles.length - maxFiles, 0);
  if (omittedFiles > 0) {
    limitations.add(
      `Drizzle source selection stopped at the ${maxFiles}-file limit; ${omittedFiles} file${omittedFiles === 1 ? " was" : "s were"} omitted.`,
    );
  }

  return {
    scope,
    applicableProjectIds: [...applicableProjectIds].sort(),
    files: orderedFiles.slice(0, maxFiles),
    limitations: boundedLimitations(limitations, maxLimitations),
  };
}
