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

interface ProjectIndex {
  readonly byId: ReadonlyMap<string, DetectedProject>;
  readonly deepestOwners: (path: string) => readonly DetectedProject[];
  readonly descendantProjects: (project: DetectedProject) => readonly DetectedProject[];
  readonly workspaceContextProjectIds: (project: DetectedProject) => ReadonlySet<string>;
}

function buildProjectIndex(snapshot: ProjectSnapshot): ProjectIndex {
  const byId = new Map(snapshot.projects.map((project) => [project.id, project]));
  const projectsByRoot = new Map<string, DetectedProject[]>();
  for (const project of snapshot.projects) {
    const projects = projectsByRoot.get(project.root) ?? [];
    projects.push(project);
    projectsByRoot.set(project.root, projects);
  }
  for (const projects of projectsByRoot.values()) {
    projects.sort((left, right) => left.id.localeCompare(right.id));
  }

  const descendantsByProjectId = new Map<string, DetectedProject[]>();
  for (const candidate of snapshot.projects) {
    const ancestorRoots = new Set<string>(["."]);
    if (candidate.root !== ".") {
      let prefix = candidate.root;
      while (prefix.length > 0) {
        ancestorRoots.add(prefix);
        const separator = prefix.lastIndexOf("/");
        if (separator < 0) break;
        prefix = prefix.slice(0, separator);
      }
    }
    for (const root of ancestorRoots) {
      for (const ancestor of projectsByRoot.get(root) ?? []) {
        const descendants = descendantsByProjectId.get(ancestor.id) ?? [];
        descendants.push(candidate);
        descendantsByProjectId.set(ancestor.id, descendants);
      }
    }
  }

  const supportedOwnersByMemberRoot = new Map<string, string[]>();
  for (const workspace of snapshot.workspaces) {
    if (!workspace.supported) continue;
    for (const root of workspace.matchedProjectRoots) {
      const owners = supportedOwnersByMemberRoot.get(root) ?? [];
      owners.push(workspace.ownerProjectId);
      supportedOwnersByMemberRoot.set(root, owners);
    }
  }

  return {
    byId,
    deepestOwners(path) {
      let prefix = path;
      while (prefix.length > 0) {
        const exact = projectsByRoot.get(prefix);
        if (exact !== undefined) return exact;
        const separator = prefix.lastIndexOf("/");
        if (separator < 0) break;
        prefix = prefix.slice(0, separator);
      }
      return projectsByRoot.get(".") ?? [];
    },
    descendantProjects(project) {
      return descendantsByProjectId.get(project.id) ?? [];
    },
    workspaceContextProjectIds(project) {
      const context = new Set([project.id]);
      const visitedRoots = new Set<string>();
      const queue = [project.root];
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const root = queue[cursor]!;
        if (visitedRoots.has(root)) continue;
        visitedRoots.add(root);
        for (const ownerId of supportedOwnersByMemberRoot.get(root) ?? []) {
          if (context.has(ownerId)) continue;
          const owner = byId.get(ownerId);
          if (owner === undefined) continue;
          context.add(owner.id);
          queue.push(owner.root);
        }
      }
      return context;
    },
  };
}

function uniqueOwner(
  path: string,
  index: ProjectIndex,
): DetectedProject | "ambiguous" | undefined {
  const candidates = index.deepestOwners(path);
  if (candidates.length === 0) return undefined;
  return candidates.length === 1 ? candidates[0] : "ambiguous";
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

interface DependencyEvidence {
  readonly names: ReadonlySet<string>;
  readonly invalidManifestPaths: readonly string[];
  readonly known: boolean;
}

function dependencyIndex(snapshot: ProjectSnapshot): ReadonlyMap<string, DependencyEvidence> {
  const manifestsByPath = new Map(snapshot.manifests.map((manifest) => [manifest.path, manifest]));
  return new Map(snapshot.projects.map((project) => {
    const names = new Set(project.dependencyNames ?? []);
    const invalidManifestPaths: string[] = [];
    let hasUsableManifest = false;
    for (const path of project.manifestPaths) {
      const manifest = manifestsByPath.get(path);
      if (manifest === undefined) continue;
      if (manifest.status === "invalid") {
        invalidManifestPaths.push(path);
        continue;
      }
      hasUsableManifest = true;
      for (const name of manifestDependencyNames(manifest)) names.add(name);
    }
    return [project.id, {
      names,
      invalidManifestPaths: invalidManifestPaths.sort(),
      known:
        invalidManifestPaths.length === 0 &&
        (project.dependencyNames !== undefined || hasUsableManifest),
    }] as const;
  }));
}

function dependencyApplicable(
  project: DetectedProject,
  index: ProjectIndex,
  dependencies: ReadonlyMap<string, DependencyEvidence>,
): boolean {
  const ownEvidence = dependencies.get(project.id);
  if (
    ownEvidence?.names.has(DRIZZLE_DEPENDENCY) &&
    ownEvidence.names.has(POSTGRES_JS_DEPENDENCY)
  ) {
    return ownEvidence.known;
  }
  const combined = new Set<string>();
  for (const projectId of index.workspaceContextProjectIds(project)) {
    const evidence = dependencies.get(projectId);
    if (evidence === undefined || !evidence.known) return false;
    for (const dependency of evidence.names) combined.add(dependency);
  }
  return combined.has(DRIZZLE_DEPENDENCY) && combined.has(POSTGRES_JS_DEPENDENCY);
}

class BoundedFileSelection {
  readonly #files: FileRecord[] = [];
  #candidateCount = 0;

  constructor(readonly maxFiles: number) {}

  admit(file: FileRecord): void {
    this.#candidateCount += 1;
    if (this.#files.length < this.maxFiles) {
      this.#files.push(file);
      this.#bubbleUp(this.#files.length - 1);
      return;
    }
    const latest = this.#files[0];
    if (latest === undefined || file.path.localeCompare(latest.path) >= 0) return;
    this.#files[0] = file;
    this.#sinkDown(0);
  }

  orderedFiles(): readonly FileRecord[] {
    return [...this.#files].sort((left, right) => left.path.localeCompare(right.path));
  }

  omittedCount(): number {
    return this.#candidateCount - this.#files.length;
  }

  #bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#files[parent]!.path.localeCompare(this.#files[index]!.path) >= 0) return;
      [this.#files[parent], this.#files[index]] = [this.#files[index]!, this.#files[parent]!];
      index = parent;
    }
  }

  #sinkDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let latest = index;
      if (
        left < this.#files.length &&
        this.#files[left]!.path.localeCompare(this.#files[latest]!.path) > 0
      ) latest = left;
      if (
        right < this.#files.length &&
        this.#files[right]!.path.localeCompare(this.#files[latest]!.path) > 0
      ) latest = right;
      if (latest === index) return;
      [this.#files[index], this.#files[latest]] = [this.#files[latest]!, this.#files[index]!];
      index = latest;
    }
  }
}

function boundedLimitations(values: ReadonlySet<string>, max: number): readonly string[] {
  const ordered = [...values].sort();
  if (ordered.length <= max) return ordered;
  const retainedCount = Math.max(max - 1, 0);
  const omitted = ordered.length - retainedCount;
  return [
    ...ordered.slice(0, retainedCount),
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
  const projectIndex = buildProjectIndex(snapshot);
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
    const owner = uniqueOwner(path, projectIndex);
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
      dependencyApplicable(project, projectIndex, dependencies)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const applicableProjectIds = new Set(applicableProjects.map(({ id }) => id));

  const consideredProjects = snapshot.projects.filter((project) =>
    scope === "full" || affected.has(project.id)
  );
  const consideredProjectIds = new Set(consideredProjects.map((project) => project.id));
  const unknownDependencyProjectIds = new Set<string>();
  for (const project of consideredProjects) {
    if (!project.ecosystems.includes("node") || sourceProvenProjectIds.has(project.id)) continue;
    const evidence = dependencies.get(project.id);
    if (evidence?.known) continue;
    unknownDependencyProjectIds.add(project.id);
    if (evidence !== undefined && evidence.invalidManifestPaths.length > 0) {
      for (const path of evidence.invalidManifestPaths) {
        limitations.add(
          `${path}: invalid dependency manifest prevents complete Drizzle applicability analysis for project ${project.id}.`,
        );
      }
      continue;
    }
    limitations.add(
      `${project.root}: dependency metadata is unavailable; Drizzle applicability is unknown for project ${project.id}.`,
    );
  }

  for (const workspace of snapshot.workspaces) {
    if (workspace.supported) continue;
    const owner = projectIndex.byId.get(workspace.ownerProjectId);
    if (owner === undefined) continue;
    const inScopeBoundaryProjects = projectIndex
      .descendantProjects(owner)
      .filter((project) => consideredProjectIds.has(project.id));
    if (inScopeBoundaryProjects.length === 0) continue;
    const boundaryProjects = scope === "full"
      ? inScopeBoundaryProjects
      : [...new Map([owner, ...inScopeBoundaryProjects].map((project) => [project.id, project])).values()];
    const boundaryDependencies = new Set<string>();
    for (const project of boundaryProjects) {
      for (const dependency of dependencies.get(project.id)?.names ?? []) {
        boundaryDependencies.add(dependency);
      }
    }
    const hasUnresolvedRelevantProject = boundaryProjects.some((project) => {
      if (applicableProjectIds.has(project.id)) return false;
      const ownDependencies = dependencies.get(project.id)?.names ?? new Set<string>();
      return ownDependencies.has(DRIZZLE_DEPENDENCY) || ownDependencies.has(POSTGRES_JS_DEPENDENCY);
    });
    if (
      hasUnresolvedRelevantProject &&
      boundaryDependencies.has(DRIZZLE_DEPENDENCY) &&
      boundaryDependencies.has(POSTGRES_JS_DEPENDENCY)
    ) {
      limitations.add(
        `${workspace.sourcePath}: unsupported workspace boundary prevents complete Drizzle applicability analysis.`,
      );
    }
  }

  const selected = new BoundedFileSelection(maxFiles);
  if (scope === "full") {
    for (const file of snapshot.files) {
      if (file.kind !== "file" || !supportsSource(file.path)) continue;
      const owner = uniqueOwner(file.path, projectIndex);
      if (owner === "ambiguous") {
        const candidates = projectIndex
          .deepestOwners(file.path)
          .filter((project) => applicableProjectIds.has(project.id));
        if (candidates.length > 0) {
          limitations.add(
            `${file.path}: source ownership is ambiguous; Drizzle analysis was withheld.`,
          );
        }
        continue;
      }
      if (owner !== undefined && applicableProjectIds.has(owner.id)) selected.admit(file);
    }
  } else {
    function recordUnavailablePreviousSource(path: string, kind: "deleted" | "renamed"): void {
      if (!supportsSource(path)) return;
      const owners = projectIndex.deepestOwners(path);
      const applicableOwners = owners.filter((owner) => applicableProjectIds.has(owner.id));
      if (applicableOwners.length === 0) return;
      if (owners.length > 1) {
        limitations.add(
          `${path}: ${kind === "deleted" ? "deleted changed" : "previous renamed"} source has ambiguous applicable ownership; analysis was withheld.`,
        );
        return;
      }
      limitations.add(
        `${path}: ${kind === "deleted" ? "deleted changed" : "previous renamed"} source could not be examined.`,
      );
    }

    for (const change of snapshot.auditScope.changes) {
      if (change.status === "deleted") {
        recordUnavailablePreviousSource(change.path, "deleted");
        continue;
      }
      if (
        change.status === "renamed" &&
        change.previousPath !== undefined &&
        change.previousPath !== change.path
      ) {
        recordUnavailablePreviousSource(change.previousPath, "renamed");
      }
      const owner = uniqueOwner(change.path, projectIndex);
      if (owner === undefined || owner === "ambiguous") {
        limitations.add(`${change.path}: changed source has no unambiguous project owner.`);
        continue;
      }
      if (
        affected.has(owner.id) &&
        !applicableProjectIds.has(owner.id) &&
        !unknownDependencyProjectIds.has(owner.id)
      ) {
        continue;
      }
      if (affected.has(owner.id) && unknownDependencyProjectIds.has(owner.id)) continue;
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
      if (!applicableProjectIds.has(owner.id)) {
        limitations.add(
          `${change.path}: changed source is outside an applicable affected Drizzle project.`,
        );
        continue;
      }
      selected.admit(file);
    }
  }

  const orderedFiles = selected.orderedFiles();
  const omittedFiles = selected.omittedCount();
  if (omittedFiles > 0) {
    limitations.add(
      `Drizzle source selection stopped at the ${maxFiles}-file limit; ${omittedFiles} file${omittedFiles === 1 ? " was" : "s were"} omitted.`,
    );
  }

  return {
    scope,
    applicableProjectIds: [...applicableProjectIds].sort(),
    files: orderedFiles,
    limitations: boundedLimitations(limitations, maxLimitations),
  };
}
