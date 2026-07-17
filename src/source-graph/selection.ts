import { posix } from "node:path";
import type { FileInventory, FileRecord } from "../workspace/types.js";
import type { SourceGraphStatus } from "./types.js";

export const DEFAULT_MAX_SOURCE_BYTES = 1_048_576;
export const DEFAULT_MAX_TOTAL_SOURCE_BYTES = 52_428_800;

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

export interface SourceFileSelectionOptions {
  readonly maxSourceBytes?: number;
  readonly maxTotalSourceBytes?: number;
}

export interface SourceFileSelection {
  readonly status: Extract<SourceGraphStatus, "completed" | "partial" | "not-applicable">;
  readonly files: readonly FileRecord[];
  readonly plannedBytes: number;
  readonly limitations: readonly string[];
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

export function selectSourceFiles(
  inventory: FileInventory,
  options: SourceFileSelectionOptions = {},
): SourceFileSelection {
  const maxSourceBytes = positiveSafeInteger(
    options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    "maxSourceBytes",
  );
  const maxTotalSourceBytes = positiveSafeInteger(
    options.maxTotalSourceBytes ?? DEFAULT_MAX_TOTAL_SOURCE_BYTES,
    "maxTotalSourceBytes",
  );
  const candidates = inventory.files
    .filter(({ path }) => isSourcePath(path))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (candidates.length === 0) {
    return {
      status: "not-applicable",
      files: [],
      plannedBytes: 0,
      limitations: [],
    };
  }

  const selected: FileRecord[] = [];
  const limitations: string[] = [];
  let plannedBytes = 0;
  for (const candidate of candidates) {
    if (candidate.kind === "symlink") {
      limitations.push(`${candidate.path}: source symlink was not parsed.`);
      continue;
    }
    if (candidate.size > maxSourceBytes) {
      limitations.push(
        `${candidate.path}: source file exceeds the ${maxSourceBytes}-byte per-file limit.`,
      );
      continue;
    }
    if (plannedBytes + candidate.size > maxTotalSourceBytes) {
      limitations.push(
        `Source selection stopped at the ${maxTotalSourceBytes}-byte total source limit before ${candidate.path}.`,
      );
      break;
    }
    selected.push({ ...candidate });
    plannedBytes += candidate.size;
  }

  return {
    status: limitations.length === 0 ? "completed" : "partial",
    files: selected,
    plannedBytes,
    limitations: limitations.sort(),
  };
}
