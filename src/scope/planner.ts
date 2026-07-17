import type { AuditBase, AuditScope, ChangedPath, ScopeReason } from "./types.js";
import type { DetectedProject } from "../workspace/types.js";

const ROOT_CONTEXT_FILES = new Set([
  ".codebase-doctor.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "Cargo.toml",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "go.work",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pom.xml",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "settings.gradle",
  "settings.gradle.kts",
  "yarn.lock",
]);

function isRootContext(path: string): boolean {
  if (path.includes("/")) return false;
  return ROOT_CONTEXT_FILES.has(path) || /^tsconfig(?:\..+)?\.json$/.test(path) ||
    /^requirements(?:[-.].*)?\.txt$/.test(path);
}

function projectDepth(project: DetectedProject): number {
  return project.root === "." ? 0 : project.root.split("/").length;
}

function containsPath(project: DetectedProject, path: string): boolean {
  return project.root === "." || path === project.root || path.startsWith(`${project.root}/`);
}

function ownerOf(
  path: string,
  projects: readonly DetectedProject[],
): DetectedProject | undefined {
  return projects
    .filter((project) => containsPath(project, path))
    .sort((left, right) =>
      projectDepth(right) - projectDepth(left) || left.id.localeCompare(right.id),
    )[0];
}

function compareChanges(left: ChangedPath, right: ChangedPath): number {
  return left.path.localeCompare(right.path) ||
    (left.previousPath ?? "").localeCompare(right.previousPath ?? "") ||
    left.status.localeCompare(right.status);
}

function changeKey(change: ChangedPath): string {
  return `${change.path}\0${change.previousPath ?? ""}\0${change.status}`;
}

function normalizeChanges(changes: readonly ChangedPath[]): ChangedPath[] {
  const unique = new Map<string, ChangedPath>();
  for (const change of changes) {
    unique.set(changeKey(change), {
      status: change.status,
      path: change.path,
      ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
    });
  }
  return [...unique.values()].sort(compareChanges);
}

function compareReasons(left: ScopeReason, right: ScopeReason): number {
  return left.projectId.localeCompare(right.projectId) ||
    left.reason.localeCompare(right.reason) || left.source.localeCompare(right.source);
}

function reasonKey(reason: ScopeReason): string {
  return `${reason.projectId}\0${reason.reason}\0${reason.source}`;
}

interface ReverseEdge {
  readonly dependency: DetectedProject;
  readonly consumer: DetectedProject;
  readonly dependencyName: string;
}

function packageName(project: DetectedProject): string {
  return project.packageName?.trim() ?? "";
}

function reverseEdges(projects: readonly DetectedProject[]): {
  edges: readonly ReverseEdge[];
  limitations: readonly string[];
} {
  const projectsByName = new Map<string, DetectedProject[]>();
  for (const project of projects) {
    const name = packageName(project);
    if (name.length === 0) continue;
    const sameName = projectsByName.get(name) ?? [];
    sameName.push(project);
    projectsByName.set(name, sameName);
  }

  const limitations: string[] = [];
  const uniqueProjectsByName = new Map<string, DetectedProject>();
  for (const [name, namedProjects] of [...projectsByName].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ordered = [...namedProjects].sort((left, right) => left.id.localeCompare(right.id));
    if (ordered.length === 1) {
      const onlyProject = ordered[0];
      if (onlyProject !== undefined) uniqueProjectsByName.set(name, onlyProject);
      continue;
    }
    limitations.push(
      `Package name "${name}" is declared by multiple projects: ${ordered.map(({ id }) => id).join(", ")}; dependency propagation for that name was skipped.`,
    );
  }

  const edges = new Map<string, ReverseEdge>();
  for (const consumer of projects) {
    for (const rawDependencyName of consumer.dependencyNames ?? []) {
      const dependencyName = rawDependencyName.trim();
      const dependency = uniqueProjectsByName.get(dependencyName);
      if (dependency === undefined || dependency.id === consumer.id) continue;
      const edge = { dependency, consumer, dependencyName };
      edges.set(`${dependency.id}\0${consumer.id}\0${dependencyName}`, edge);
    }
  }

  return {
    edges: [...edges.values()].sort((left, right) =>
      left.dependency.id.localeCompare(right.dependency.id) ||
      left.consumer.id.localeCompare(right.consumer.id) ||
      left.dependencyName.localeCompare(right.dependencyName),
    ),
    limitations,
  };
}

export function planChangedScope(
  base: AuditBase,
  changes: readonly ChangedPath[],
  projects: readonly DetectedProject[],
): AuditScope {
  const orderedChanges = normalizeChanges(changes);
  if (orderedChanges.length === 0) {
    return {
      mode: "changed",
      base: { ...base },
      changes: [],
      affectedProjectIds: [],
      reasons: [],
      limitations: [],
    };
  }
  const orderedProjects = [...projects].sort((left, right) => left.id.localeCompare(right.id));
  const affected = new Set<string>();
  const reasons = new Map<string, ScopeReason>();

  const addReason = (reason: ScopeReason): void => {
    affected.add(reason.projectId);
    reasons.set(reasonKey(reason), reason);
  };

  for (const change of orderedChanges) {
    const paths = [...new Set([
      change.path,
      ...(change.previousPath === undefined ? [] : [change.previousPath]),
    ])].sort();
    for (const path of paths) {
      if (isRootContext(path)) {
        for (const project of orderedProjects) {
          addReason({ projectId: project.id, reason: "root-context", source: path });
        }
        continue;
      }
      const owner = ownerOf(path, orderedProjects);
      if (owner !== undefined) {
        addReason({ projectId: owner.id, reason: "direct-change", source: path });
      }
    }
  }

  const graph = reverseEdges(orderedProjects);
  const outgoing = new Map<string, ReverseEdge[]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.dependency.id) ?? [];
    edges.push(edge);
    outgoing.set(edge.dependency.id, edges);
  }

  const queue = [...affected].sort();
  for (let index = 0; index < queue.length; index += 1) {
    const projectId = queue[index];
    if (projectId === undefined) continue;
    for (const edge of outgoing.get(projectId) ?? []) {
      if (affected.has(edge.consumer.id)) continue;
      affected.add(edge.consumer.id);
      queue.push(edge.consumer.id);
      const consumerName = packageName(edge.consumer) || edge.consumer.id;
      addReason({
        projectId: edge.consumer.id,
        reason: "workspace-dependent",
        source: `${edge.dependencyName} -> ${consumerName}`,
      });
    }
  }

  return {
    mode: "changed",
    base: { ...base },
    changes: orderedChanges,
    affectedProjectIds: [...affected].sort(),
    reasons: [...reasons.values()].sort(compareReasons),
    limitations: [...graph.limitations],
  };
}

export function fullAuditScope(): AuditScope {
  return {
    mode: "full",
    base: null,
    changes: [],
    affectedProjectIds: [],
    reasons: [],
    limitations: [],
  };
}
