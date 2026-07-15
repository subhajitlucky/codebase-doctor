import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  FileInventory,
  FileInventoryOptions,
  FileRecord,
} from "./types.js";

const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_DEPTH = 50;

const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith(".venv-");
}

export class WorkspaceInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceInventoryError";
  }
}

function readLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new WorkspaceInventoryError(`${name} must be a non-negative integer.`);
  }
  return limit;
}

export async function inventoryFiles(
  requestedRoot: string,
  options: FileInventoryOptions = {},
): Promise<FileInventory> {
  const root = resolve(requestedRoot);
  const maxFiles = readLimit(options.maxFiles, DEFAULT_MAX_FILES, "File limit");
  const maxDepth = readLimit(options.maxDepth, DEFAULT_MAX_DEPTH, "Depth limit");

  let rootStatus;
  try {
    rootStatus = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceInventoryError(`Workspace root does not exist: ${root}`);
    }
    throw error;
  }

  if (!rootStatus.isDirectory()) {
    throw new WorkspaceInventoryError(`Workspace root must be a directory: ${root}`);
  }

  const files: FileRecord[] = [];

  function addFile(record: FileRecord): void {
    if (files.length >= maxFiles) {
      throw new WorkspaceInventoryError(
        `Workspace file limit of ${maxFiles} was exceeded.`,
      );
    }
    files.push(record);
  }

  async function walk(directory: string, segments: readonly string[], depth: number): Promise<void> {
    const names = (await readdir(directory)).sort();

    for (const name of names) {
      const absolutePath = join(directory, name);
      const relativeSegments = [...segments, name];
      const relativePath = relativeSegments.join("/");
      const status = await lstat(absolutePath);

      if (status.isSymbolicLink()) {
        addFile({ path: relativePath, kind: "symlink", size: status.size });
        continue;
      }

      if (status.isDirectory()) {
        if (isIgnoredDirectory(name)) continue;

        const nextDepth = depth + 1;
        if (nextDepth > maxDepth) {
          throw new WorkspaceInventoryError(
            `Workspace depth limit of ${maxDepth} was exceeded at ${relativePath}.`,
          );
        }
        await walk(absolutePath, relativeSegments, nextDepth);
        continue;
      }

      if (status.isFile()) {
        addFile({ path: relativePath, kind: "file", size: status.size });
      }
    }
  }

  await walk(root, [], 0);
  return { root, files };
}
