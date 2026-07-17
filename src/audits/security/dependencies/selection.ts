import { posix } from "node:path";
import type {
  DetectedProject,
  FileRecord,
  ProjectSnapshot,
} from "../../../workspace/types.js";

export interface CoveredDependencyProject {
  readonly projectId: string;
  readonly root: string;
  readonly manifestPath?: string;
}

export interface DependencyAuditTarget {
  readonly lockRoot: string;
  readonly authority: "package-lock" | "shrinkwrap" | "none";
  readonly lockfile?: FileRecord;
  readonly coveredProjects: readonly CoveredDependencyProject[];
  readonly competingLockfilePaths: readonly string[];
  readonly scope: "full" | "changed";
}

export interface UnsupportedDependencyScope {
  readonly projectId: string;
  readonly root: string;
  readonly ecosystem: string;
}

export interface NotApplicableDependencyScope {
  readonly projectId: string;
  readonly root: string;
}

export interface DependencyAuditSelection {
  readonly scope: "full" | "changed";
  readonly targets: readonly DependencyAuditTarget[];
  readonly unsupportedScopes: readonly UnsupportedDependencyScope[];
  readonly notApplicableScopes: readonly NotApplicableDependencyScope[];
  readonly limitations: readonly string[];
}

function pathAtRoot(root: string, basename: string): string {
  return root === "." ? basename : `${root}/${basename}`;
}

function packageManifestPath(project: DetectedProject): string | undefined {
  const expected = pathAtRoot(project.root, "package.json");
  return project.manifestPaths.includes(expected)
    ? expected
    : [...project.manifestPaths].sort().find((path) => posix.basename(path) === "package.json");
}

function isNodeProject(project: DetectedProject): boolean {
  return project.ecosystems.some((ecosystem) => ecosystem.toLowerCase() === "node");
}

function unsupportedEcosystem(project: DetectedProject): string | undefined {
  if (!isNodeProject(project)) return [...project.ecosystems].sort()[0] ?? "unknown";
  if (
    project.packageManager !== undefined &&
    project.packageManager !== "npm"
  ) {
    return `node:${project.packageManager}`;
  }
  return undefined;
}

function dependencyFree(project: DetectedProject): boolean {
  return project.dependencyNames !== undefined && project.dependencyNames.length === 0;
}

interface NpmAuthority {
  authority: DependencyAuditTarget["authority"];
  lockfile?: FileRecord;
  competingLockfilePaths: string[];
}

function authorityAtRoot(
  root: string,
  filesByPath: ReadonlyMap<string, FileRecord>,
  limitations: Set<string>,
): NpmAuthority {
  const packageLockPath = pathAtRoot(root, "package-lock.json");
  const shrinkwrapPath = pathAtRoot(root, "npm-shrinkwrap.json");
  const packageLock = filesByPath.get(packageLockPath);
  const shrinkwrap = filesByPath.get(shrinkwrapPath);
  if (packageLock?.kind === "symlink") {
    limitations.add(
      `${packageLockPath}: selected npm lockfile is not an inventoried regular file.`,
    );
  }
  if (shrinkwrap?.kind === "symlink") {
    limitations.add(
      `${shrinkwrapPath}: selected npm lockfile is not an inventoried regular file.`,
    );
  }
  if (shrinkwrap?.kind === "file") {
    return {
      authority: "shrinkwrap",
      lockfile: shrinkwrap,
      competingLockfilePaths: packageLock?.kind === "file" ? [packageLockPath] : [],
    };
  }
  if (packageLock?.kind === "file") {
    return {
      authority: "package-lock",
      lockfile: packageLock,
      competingLockfilePaths: [],
    };
  }
  return { authority: "none", competingLockfilePaths: [] };
}

export function selectDependencyAuditTargets(
  snapshot: ProjectSnapshot,
): DependencyAuditSelection {
  const scope = snapshot.auditScope.mode;
  const limitations = new Set<string>();
  const filesByPath = new Map(snapshot.files.map((entry) => [entry.path, entry]));
  const manifestsByPath = new Map(snapshot.manifests.map((entry) => [entry.path, entry]));
  const projectsById = new Map(snapshot.projects.map((entry) => [entry.id, entry]));
  const affected = new Set(snapshot.auditScope.affectedProjectIds);
  const selectedProjects = snapshot.projects
    .filter((entry) => scope === "full" || affected.has(entry.id))
    .sort((left, right) => left.root.localeCompare(right.root));

  const unsupportedScopes: UnsupportedDependencyScope[] = [];
  const notApplicableScopes: NotApplicableDependencyScope[] = [];
  const analyzableProjects: DetectedProject[] = [];
  for (const project of selectedProjects) {
    const ecosystem = unsupportedEcosystem(project);
    if (ecosystem !== undefined) {
      unsupportedScopes.push({ projectId: project.id, root: project.root, ecosystem });
      continue;
    }
    if (dependencyFree(project)) {
      notApplicableScopes.push({ projectId: project.id, root: project.root });
      continue;
    }
    analyzableProjects.push(project);
  }

  const authorityByRoot = new Map<string, NpmAuthority>();
  function authority(root: string): NpmAuthority {
    const existing = authorityByRoot.get(root);
    if (existing !== undefined) return existing;
    const created = authorityAtRoot(root, filesByPath, limitations);
    authorityByRoot.set(root, created);
    return created;
  }

  function governingRoot(project: DetectedProject): string {
    if (authority(project.root).authority !== "none") return project.root;
    const owners = snapshot.workspaces
      .filter((workspace) =>
        workspace.supported && workspace.matchedProjectRoots.includes(project.root)
      )
      .map((workspace) => projectsById.get(workspace.ownerProjectId))
      .filter((owner): owner is DetectedProject => owner !== undefined)
      .filter((owner) => unsupportedEcosystem(owner) === undefined)
      .sort((left, right) => right.root.length - left.root.length || left.root.localeCompare(right.root));
    return owners[0]?.root ?? project.root;
  }

  const projectsByLockRoot = new Map<string, DetectedProject[]>();
  for (const project of analyzableProjects) {
    const root = governingRoot(project);
    const grouped = projectsByLockRoot.get(root) ?? [];
    grouped.push(project);
    projectsByLockRoot.set(root, grouped);
  }

  for (const workspace of snapshot.workspaces) {
    if (
      !workspace.supported &&
      selectedProjects.some((project) => project.id === workspace.ownerProjectId)
    ) {
      limitations.add(
        `${workspace.sourcePath}: unsupported workspace pattern limits dependency lock ownership.`,
      );
    }
  }

  const targets: DependencyAuditTarget[] = [...projectsByLockRoot.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([lockRoot, projects]) => {
      const selectedAuthority = authority(lockRoot);
      const coveredProjects = projects
        .sort((left, right) => left.root.localeCompare(right.root))
        .map((project): CoveredDependencyProject => {
          const manifestPath = packageManifestPath(project);
          if (manifestPath !== undefined) {
            const manifest = manifestsByPath.get(manifestPath);
            if (manifest?.status === "invalid") {
              limitations.add(
                `${manifestPath}: invalid package manifest limits dependency analysis.`,
              );
            }
          }
          return {
            projectId: project.id,
            root: project.root,
            ...(manifestPath === undefined ? {} : { manifestPath }),
          };
        });
      return {
        lockRoot,
        authority: selectedAuthority.authority,
        ...(selectedAuthority.lockfile === undefined
          ? {}
          : { lockfile: selectedAuthority.lockfile }),
        coveredProjects,
        competingLockfilePaths: selectedAuthority.competingLockfilePaths,
        scope,
      };
    });

  for (const change of snapshot.auditScope.changes) {
    if (
      change.status === "deleted" &&
      ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(posix.basename(change.path))
    ) {
      limitations.add(`${change.path}: deleted dependency metadata could not be examined.`);
    }
  }

  return {
    scope,
    targets,
    unsupportedScopes: unsupportedScopes.sort((left, right) => left.root.localeCompare(right.root)),
    notApplicableScopes: notApplicableScopes.sort((left, right) => left.root.localeCompare(right.root)),
    limitations: [...limitations].sort(),
  };
}
