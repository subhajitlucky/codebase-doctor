import type { DetectedProject, ProjectSnapshot } from "../../../workspace/types.js";
import type { AuditScope } from "../../../scope/types.js";
import type { SqlMigrationStream } from "./types.js";

const MIGRATION_ROOTS = [
  "database/migrations",
  "db/migrations",
  "drizzle",
  "migrations",
  "prisma/migrations",
  "supabase/migrations",
] as const;

function projectPath(root: string, relative: string): string {
  return root === "." ? relative : `${root}/${relative}`;
}

function relativeToProject(path: string, projectRoot: string): string | undefined {
  if (projectRoot === ".") return path;
  const prefix = `${projectRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function projectDepth(project: DetectedProject): number {
  return project.root === "." ? 0 : project.root.split("/").length;
}

function projects(snapshot: Pick<ProjectSnapshot, "projects">): readonly DetectedProject[] {
  if (snapshot.projects.length > 0) return snapshot.projects;
  return [{
    id: "root",
    root: ".",
    ecosystems: [],
    languages: [],
    frameworks: [],
    manifestPaths: [],
    executionSupport: "detected-only",
  }];
}

function ownerOf(path: string, candidates: readonly DetectedProject[]): DetectedProject {
  return [...candidates]
    .filter((project) => relativeToProject(path, project.root) !== undefined)
    .sort((left, right) =>
      projectDepth(right) - projectDepth(left) || left.id.localeCompare(right.id)
    )[0] ?? candidates[0]!;
}

export interface SqlStreamIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly root: string;
}

/** Maps a repository path to one of the SQL stream roots supported by static auditing. */
export function identifySqlStream(
  snapshot: Pick<ProjectSnapshot, "projects">,
  path: string,
): SqlStreamIdentity | undefined {
  const projectList = projects(snapshot);
  const owner = ownerOf(path, projectList);
  const relativePath = relativeToProject(path, owner.root);
  if (relativePath === undefined) return undefined;

  for (const relativeRoot of MIGRATION_ROOTS) {
    if (relativePath !== relativeRoot && !relativePath.startsWith(`${relativeRoot}/`)) continue;
    return {
      id: `${owner.id}:${relativeRoot}`,
      projectId: owner.id,
      root: projectPath(owner.root, relativeRoot),
    };
  }
  if (relativePath === "schema.sql") {
    return {
      id: `${owner.id}:schema.sql`,
      projectId: owner.id,
      root: projectPath(owner.root, "schema.sql"),
    };
  }
  return undefined;
}

function pathIsInStream(path: string, stream: SqlMigrationStream): boolean {
  return path === stream.root || path.startsWith(`${stream.root}/`);
}

/** Selects current streams affected by an audit scope without mutating either input. */
export function selectSqlStreams(
  streams: readonly SqlMigrationStream[],
  scope: AuditScope,
): SqlMigrationStream[] {
  if (scope.mode === "full") return [...streams];
  const paths = scope.changes.flatMap((change) => [
    change.path,
    ...(change.status === "renamed" && change.previousPath !== undefined
      ? [change.previousPath]
      : []),
  ]);
  return streams.filter((stream) => paths.some((path) => pathIsInStream(path, stream)));
}

export function discoverSqlStreams(snapshot: ProjectSnapshot): SqlMigrationStream[] {
  const projectList = projects(snapshot);
  const filesByProject = new Map<string, string[]>();
  for (const file of snapshot.files) {
    if (file.kind !== "file" || !file.path.toLowerCase().endsWith(".sql")) continue;
    const owner = ownerOf(file.path, projectList);
    const files = filesByProject.get(owner.id) ?? [];
    files.push(file.path);
    filesByProject.set(owner.id, files);
  }

  const streams: SqlMigrationStream[] = [];
  for (const project of projectList) {
    const projectFiles = filesByProject.get(project.id) ?? [];
    let foundMigration = false;
    for (const relativeRoot of MIGRATION_ROOTS) {
      const absoluteRoot = projectPath(project.root, relativeRoot);
      const matching = projectFiles
        .filter((path) => path.startsWith(`${absoluteRoot}/`))
        .sort();
      if (matching.length === 0) continue;
      foundMigration = true;
      streams.push({
        id: `${project.id}:${relativeRoot}`,
        projectId: project.id,
        root: absoluteRoot,
        dialect: "postgresql",
        files: matching,
      });
    }

    const schemaPath = projectPath(project.root, "schema.sql");
    if (!foundMigration && projectFiles.includes(schemaPath)) {
      streams.push({
        id: `${project.id}:schema.sql`,
        projectId: project.id,
        root: schemaPath,
        dialect: "postgresql",
        files: [schemaPath],
      });
    }
  }

  return streams.sort((left, right) => left.root.localeCompare(right.root));
}
