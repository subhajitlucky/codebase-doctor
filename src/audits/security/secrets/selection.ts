import type { FileRecord, ProjectSnapshot } from "../../../workspace/types.js";

const FALLBACK_LIMITATION =
  "Git shareable-file selection was unavailable; conservative local-environment fallback rules were used.";

export interface SecretAuditFileSelection {
  readonly scope: "full" | "changed";
  readonly files: readonly FileRecord[];
  readonly limitations: readonly string[];
}

function isLocalEnvironmentFile(path: string): boolean {
  const basename = path.split("/").at(-1) ?? path;
  if (/(?:\.example|\.sample|\.template)$/iu.test(basename)) return false;
  return basename === ".env" || basename.startsWith(".env.");
}

function sortedUniqueFiles(files: readonly FileRecord[]): FileRecord[] {
  const unique = new Map(files.map((file) => [file.path, file]));
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function fullSelection(snapshot: ProjectSnapshot): SecretAuditFileSelection {
  const regularFiles = snapshot.files.filter(({ kind }) => kind === "file");
  if (snapshot.repositoryFiles?.availability === "available") {
    const selectedPaths = new Set(snapshot.repositoryFiles.paths);
    return {
      scope: "full",
      files: sortedUniqueFiles(regularFiles.filter(({ path }) => selectedPaths.has(path))),
      limitations: [...new Set(snapshot.repositoryFiles.limitations)].sort(),
    };
  }

  return {
    scope: "full",
    files: sortedUniqueFiles(regularFiles.filter(({ path }) => !isLocalEnvironmentFile(path))),
    limitations: [...new Set(
      snapshot.repositoryFiles?.limitations.length
        ? snapshot.repositoryFiles.limitations
        : [FALLBACK_LIMITATION],
    )].sort(),
  };
}

function changedSelection(snapshot: ProjectSnapshot): SecretAuditFileSelection {
  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const selected: FileRecord[] = [];
  const limitations: string[] = [];

  for (const change of snapshot.auditScope.changes) {
    if (change.status === "deleted") {
      limitations.push(`${change.path}: deleted changed path could not be examined for secrets.`);
      continue;
    }
    const file = filesByPath.get(change.path);
    if (file === undefined || file.kind !== "file") {
      limitations.push(`${change.path}: selected path is not an inventoried regular file.`);
      continue;
    }
    selected.push(file);
  }

  return {
    scope: "changed",
    files: sortedUniqueFiles(selected),
    limitations: [...new Set(limitations)].sort(),
  };
}

export function selectSecretAuditFiles(snapshot: ProjectSnapshot): SecretAuditFileSelection {
  return snapshot.auditScope.mode === "changed"
    ? changedSelection(snapshot)
    : fullSelection(snapshot);
}
