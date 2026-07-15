import type { DetectedProject, ProjectSnapshot } from "../../../workspace/types.js";
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

function projects(snapshot: ProjectSnapshot): readonly DetectedProject[] {
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
    .sort((left, right) => projectDepth(right) - projectDepth(left))[0] ?? candidates[0]!;
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
