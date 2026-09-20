import { posix } from "node:path";
import type {
  DetectedProject,
  FileRecord,
  ManifestRecord,
  PackageManager,
  ProjectSnapshot,
} from "../../../workspace/types.js";
import { hasExternalInstallGraph, manifestSections } from "./analyzer.js";
import type { NodeLockSummary } from "./node-locks.js";
import { classifyDependencySource } from "./source.js";
import type { DependencyMatch } from "./types.js";

const NON_NPM_LOCKS: readonly { readonly path: string; readonly manager: Exclude<PackageManager, "npm"> }[] = [
  { path: "pnpm-lock.yaml", manager: "pnpm" },
  { path: "yarn.lock", manager: "yarn" },
  { path: "bun.lock", manager: "bun" },
];
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json"] as const;
const NODE_MANAGER_ECOSYSTEMS = new Set(["node:pnpm", "node:yarn", "node:bun"]);

export interface CrossEcosystemProject {
  readonly projectId: string;
  readonly root: string;
  readonly manifestPath?: string;
}

export interface CrossEcosystemTarget {
  readonly lockRoot: string;
  readonly manager: PackageManager;
  readonly lockfile?: FileRecord;
  readonly coveredProjects: readonly CrossEcosystemProject[];
  readonly competingLockfilePaths: readonly string[];
  readonly limitations: readonly string[];
  readonly scope: "full" | "changed";
}

export interface CrossEcosystemSelection {
  readonly targets: readonly CrossEcosystemTarget[];
  readonly handledProjectIds: ReadonlySet<string>;
  readonly limitations: readonly string[];
}

function pathAtRoot(root: string, basename: string): string {
  return root === "." ? basename : `${root}/${basename}`;
}

function manifestPathFor(project: DetectedProject): string | undefined {
  const expected = pathAtRoot(project.root, "package.json");
  return project.manifestPaths.includes(expected)
    ? expected
    : [...project.manifestPaths].sort().find((path) => posix.basename(path) === "package.json");
}

function isNodeProject(project: DetectedProject): boolean {
  return project.ecosystems.some((ecosystem) => ecosystem.toLowerCase() === "node");
}

function containsRoot(owner: DetectedProject, project: DetectedProject): boolean {
  return owner.root === "." ||
    project.root === owner.root ||
    project.root.startsWith(`${owner.root}/`);
}

/**
 * Selects projects that declare or expose pnpm, Yarn, or Bun lock authority.
 * npm-managed projects remain owned by the npm selection path; Python and
 * other ecosystems remain unsupported.
 */
export function selectCrossEcosystemTargets(snapshot: ProjectSnapshot): CrossEcosystemSelection {
  const scope = snapshot.auditScope.mode;
  const filesByPath = new Map(snapshot.files.map((entry) => [entry.path, entry]));
  const affected = new Set(snapshot.auditScope.affectedProjectIds);
  const limitations = new Set<string>();

  const selectedProjects = snapshot.projects
    .filter((project) => scope === "full" || affected.has(project.id))
    .filter(isNodeProject)
    .sort((left, right) => left.root.localeCompare(right.root));

  const projectsByRoot = new Map(snapshot.projects.map((project) => [project.root, project]));

  function inheritedManager(project: DetectedProject): PackageManager | undefined {
    const ancestors = [...projectsByRoot.values()]
      .filter((candidate) => containsRoot(candidate, project))
      .sort((left, right) =>
        right.root.split("/").length - left.root.split("/").length ||
        left.root.localeCompare(right.root)
      );
    for (const candidate of ancestors) {
      if (candidate.packageManager !== undefined) return candidate.packageManager;
    }
    return undefined;
  }

  function presentNonNpmLocks(root: string): { path: string; manager: Exclude<PackageManager, "npm">; record: FileRecord }[] {
    return NON_NPM_LOCKS
      .map(({ path, manager }) => {
        const record = filesByPath.get(pathAtRoot(root, path));
        return record?.kind === "file" ? { path: record.path, manager, record } : undefined;
      })
      .filter((entry): entry is { path: string; manager: Exclude<PackageManager, "npm">; record: FileRecord } => entry !== undefined);
  }

  function presentNpmLocks(root: string): string[] {
    return NPM_LOCKS
      .map((name) => filesByPath.get(pathAtRoot(root, name)))
      .filter((record): record is FileRecord => record?.kind === "file")
      .map((record) => record.path);
  }

  function governingRoot(project: DetectedProject): string | undefined {
    const candidates = [project, ...snapshot.projects.filter((candidate) => containsRoot(candidate, project))]
      .sort((left, right) =>
        right.root.split("/").length - left.root.split("/").length ||
        left.root.localeCompare(right.root)
      );
    return candidates.find((candidate) => presentNonNpmLocks(candidate.root).length > 0)?.root;
  }

  const byRoot = new Map<string, { rootProject: DetectedProject; projects: DetectedProject[] }>();
  for (const project of selectedProjects) {
    const manager = inheritedManager(project);
    if (manager === "npm") continue;
    const root = governingRoot(project);
    if (root === undefined && manager === undefined) continue;
    const lockRoot = root ?? project.root;
    const rootProject = projectsByRoot.get(lockRoot) ?? project;
    const grouped = byRoot.get(lockRoot) ?? { rootProject, projects: [] };
    grouped.projects.push(project);
    byRoot.set(lockRoot, grouped);
  }

  const targets: CrossEcosystemTarget[] = [];
  const handledProjectIds = new Set<string>();
  for (const [lockRoot, { rootProject, projects }] of [...byRoot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const declared = inheritedManager(rootProject);
    const present = presentNonNpmLocks(lockRoot);
    const npmLocks = presentNpmLocks(lockRoot);
    const targetLimitations: string[] = [];
    let chosen: { path: string; manager: Exclude<PackageManager, "npm">; record: FileRecord } | undefined;

    if (declared !== undefined && declared !== "npm") {
      chosen = present.find((entry) => entry.manager === declared);
      if (chosen === undefined) {
        targetLimitations.push(
          `${lockRoot}: declared package manager ${declared} has no ${declared === "yarn" ? "yarn.lock" : declared === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"}; missing-lockfile analysis applies.`,
        );
      }
    } else if (present.length === 1) {
      chosen = present[0];
    } else if (present.length > 1) {
      targetLimitations.push(
        `${lockRoot}: multiple non-npm lockfiles are present without a declared package manager; drift claims were withheld.`,
      );
    }

    const manager = declared ?? chosen?.manager;
    if (manager === undefined || manager === "npm") continue;

    const competing = [
      ...present.filter((entry) => entry.path !== chosen?.path).map((entry) => entry.path),
      ...npmLocks,
    ].sort();
    targets.push({
      lockRoot,
      manager,
      ...(chosen === undefined ? {} : { lockfile: chosen.record }),
      coveredProjects: projects.map((project): CrossEcosystemProject => {
        const manifestPath = manifestPathFor(project);
        if (manifestPath !== undefined) {
          const manifest = snapshot.manifests.find((entry) => entry.path === manifestPath);
          if (manifest?.status === "invalid") {
            limitations.add(`${manifestPath}: invalid package manifest limits dependency analysis.`);
          }
        }
        return {
          projectId: project.id,
          root: project.root,
          ...(manifestPath === undefined ? {} : { manifestPath }),
        };
      }),
      competingLockfilePaths: competing,
      limitations: targetLimitations,
      scope,
    });
    for (const project of projects) handledProjectIds.add(project.id);
  }

  for (const change of snapshot.auditScope.changes) {
    if (
      change.status === "deleted" &&
      NON_NPM_LOCKS.some(({ path }) => posix.basename(change.path) === path)
    ) {
      limitations.add(`${change.path}: deleted dependency metadata could not be examined.`);
    }
  }

  return {
    targets: targets.sort((left, right) => left.lockRoot.localeCompare(right.lockRoot)),
    handledProjectIds,
    limitations: [...limitations].sort(),
  };
}

export function isNodeManagerEcosystem(ecosystem: string): boolean {
  return NODE_MANAGER_ECOSYSTEMS.has(ecosystem);
}

export interface CrossEcosystemAnalysisInput {
  readonly target: CrossEcosystemTarget;
  readonly lock?: NodeLockSummary;
  readonly manifests: readonly ManifestRecord[];
  readonly internalNames: ReadonlySet<string>;
}

export interface CrossEcosystemAnalysisResult {
  readonly matches: readonly DependencyMatch[];
  readonly limitations: readonly string[];
}

function importerKey(lockRoot: string, projectRoot: string): string {
  const base = lockRoot === "." ? "." : lockRoot;
  const relative = posix.relative(base, projectRoot === "." ? "." : projectRoot);
  return relative === "" ? "." : relative;
}

/**
 * Applies npm-parity source, integrity, drift, and competition rules to a
 * pnpm/Yarn/Bun lock summary. Only dimensions the lockfile records are
 * compared; everything else becomes a limitation.
 */
export function analyzeCrossEcosystemTarget(
  input: CrossEcosystemAnalysisInput,
): CrossEcosystemAnalysisResult {
  const { target, lock } = input;
  const limitations = new Set<string>();
  const matches: DependencyMatch[] = target.competingLockfilePaths.map((path) => ({
    family: "competing-lockfiles",
    path,
    severity: "low",
    confidence: "high",
  }));
  const manifestByPath = new Map(input.manifests.map((entry) => [entry.path, entry]));

  if (lock !== undefined) {
    for (const limitation of lock.limitations) {
      limitations.add(`${target.lockfile?.path ?? target.lockRoot}: ${limitation}`);
    }
  }

  const lockPath = target.lockfile?.path ?? target.lockRoot;
  const seenLockMatches = new Set<string>();
  if (lock !== undefined) {
    for (const entry of lock.packages) {
      const identity = `${entry.name}\u0000${entry.sourceClass}\u0000${entry.integrity}`;
      if (seenLockMatches.has(identity)) continue;
      seenLockMatches.add(identity);
      if (entry.sourceClass === "insecure-http" || entry.sourceClass === "insecure-git") {
        matches.push({
          family: "insecure-source",
          path: lockPath,
          packageName: entry.name,
          sourceClass: entry.sourceClass,
          severity: "high",
          confidence: "high",
        });
      }
      if (entry.sourceClass === "git-mutable") {
        matches.push({
          family: "mutable-git-source",
          path: lockPath,
          packageName: entry.name,
          sourceClass: "git-mutable",
          severity: "medium",
          confidence: "high",
        });
      }
      if (entry.integrity === "missing" || entry.integrity === "invalid") {
        matches.push({
          family: "missing-integrity",
          path: lockPath,
          packageName: entry.name,
          sourceClass: entry.sourceClass,
          severity: "medium",
          confidence: "high",
        });
      }
    }
  }

  for (const project of target.coveredProjects) {
    if (project.manifestPath === undefined) {
      limitations.add(`${project.root}: package manifest path is unavailable.`);
      continue;
    }
    const manifest = manifestByPath.get(project.manifestPath);
    if (manifest === undefined || manifest.status === "invalid") {
      limitations.add(`${project.manifestPath}: valid package manifest is unavailable.`);
      continue;
    }
    const sections = manifestSections(manifest, limitations);

    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const [packageName, spec] of sections[section]) {
        const source = classifyDependencySource(spec);
        if (source.sourceClass === "insecure-http" || source.sourceClass === "insecure-git") {
          matches.push({
            family: "insecure-source",
            path: manifest.path,
            packageName,
            section,
            sourceClass: source.sourceClass,
            severity: "high",
            confidence: "high",
          });
        }
        if (source.sourceClass === "git-mutable") {
          matches.push({
            family: "mutable-git-source",
            path: manifest.path,
            packageName,
            section,
            sourceClass: "git-mutable",
            severity: "medium",
            confidence: "high",
          });
        }
      }
    }

    if (lock === undefined) {
      if (hasExternalInstallGraph(sections, input.internalNames)) {
        matches.push({
          family: "missing-lockfile",
          path: manifest.path,
          severity: "medium",
          confidence: "high",
        });
      }
      continue;
    }

    if (!lock.specifiersRecorded) {
      limitations.add(
        `${lockPath}: recorded manifest ranges are unavailable; manifest-lock drift was not compared.`,
      );
      continue;
    }

    const recorded = lock.specifiers.get(importerKey(target.lockRoot, project.root));
    if (recorded === undefined) {
      limitations.add(
        `${project.root}: lockfile records no importer entry for this project; manifest-lock drift was not compared.`,
      );
      continue;
    }

    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const [packageName, spec] of sections[section]) {
        const source = classifyDependencySource(spec).sourceClass;
        if (source === "local-file" || source === "local-link" || source === "workspace") continue;
        const ranges = recorded.get(packageName);
        if (ranges === undefined || !ranges.includes(spec)) {
          matches.push({
            family: "manifest-lock-drift",
            path: manifest.path,
            packageName,
            section,
            severity: "medium",
            confidence: "high",
          });
        }
      }
    }

    if (lock.directSpecifiersComplete) {
      const manifestNames = new Set<string>();
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
        for (const name of sections[section].keys()) manifestNames.add(name);
      }
      for (const [packageName] of recorded) {
        if (manifestNames.has(packageName)) continue;
        matches.push({
          family: "manifest-lock-drift",
          path: manifest.path,
          packageName,
          severity: "medium",
          confidence: "high",
        });
      }
    }
  }

  const uniqueMatches = new Map<string, DependencyMatch>();
  for (const match of matches) {
    uniqueMatches.set(
      `${match.family}\u0000${match.path}\u0000${match.packageName ?? ""}\u0000${match.section ?? ""}`,
      match,
    );
  }

  return {
    matches: [...uniqueMatches.values()],
    limitations: [...limitations].sort(),
  };
}

export type { NodeLockFormat, NodeLockSummary } from "./node-locks.js";
