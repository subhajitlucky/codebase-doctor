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
  readonly inferredProject?: true;
  readonly formerSchema?: true;
}

function isSqlInput(path: string): boolean {
  return path.toLowerCase().endsWith(".sql");
}

/** Maps a repository path to one of the SQL stream roots supported by static auditing. */
export function identifySqlStream(
  snapshot: ProjectSnapshot,
  path: string,
  currentStreams: readonly SqlMigrationStream[] = discoverSqlStreams(snapshot),
  allowInferredProject = true,
  allowFormerSchema = false,
): SqlStreamIdentity | undefined {
  if (!isSqlInput(path)) return undefined;
  const current = currentStreams.find((stream) => pathIsInStream(path, stream));
  if (current !== undefined) {
    return { id: current.id, projectId: current.projectId, root: current.root };
  }

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

  if (allowInferredProject) {
    const rootsBySpecificity = [...MIGRATION_ROOTS].sort((left, right) =>
      right.split("/").length - left.split("/").length || left.localeCompare(right)
    );
    for (const relativeRoot of rootsBySpecificity) {
      const marker = `/${relativeRoot}/`;
      const markerIndex = path.lastIndexOf(marker);
      if (markerIndex <= 0) continue;
      const inferredRoot = path.slice(0, markerIndex);
      const projectId = `project:${inferredRoot}`;
      return {
        id: `${projectId}:${relativeRoot}`,
        projectId,
        root: `${inferredRoot}/${relativeRoot}`,
        inferredProject: true,
      };
    }
  }

  // schema.sql is active only when discovery selected it, except when historical
  // deleted/rename-old evidence explicitly requests an honest former identity.
  if (allowFormerSchema && (path === "schema.sql" || path.endsWith("/schema.sql"))) {
    const inferredRoot = path === "schema.sql" ? "." : path.slice(0, -"/schema.sql".length);
    const projectIsCurrent = inferredRoot === owner.root;
    const projectId = projectIsCurrent ? owner.id : `project:${inferredRoot}`;
    return {
      id: `${projectId}:schema.sql`,
      projectId,
      root: path,
      formerSchema: true,
      ...(projectIsCurrent ? {} : { inferredProject: true }),
    };
  }
  return undefined;
}

function pathIsInStream(path: string, stream: SqlMigrationStream): boolean {
  if (!isSqlInput(path)) return false;
  return stream.root.toLowerCase().endsWith(".sql")
    ? path === stream.root
    : path.startsWith(`${stream.root}/`);
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
