import { compareFindings, type Finding } from "../core/findings.js";
import type { ChangedPath } from "../scope/types.js";
import type { ChangedLines } from "./changed-lines.js";

export interface DiffFilterOptions {
  /**
   * When true, skip line-level filtering and keep every finding. The review
   * still forces changed audit scope; only the diff narrowing is disabled.
   */
  readonly allFindings?: boolean;
}

export interface DiffFilterResult {
  readonly included: Finding[];
  readonly excluded: Finding[];
  /**
   * False when no added-line index was available and filtering fell back to
   * file-level matching. Review output must say so instead of implying
   * line precision.
   */
  readonly linePrecision: boolean;
}

/**
 * Narrow audit findings to the review diff.
 *
 * - Findings without a location are global (repository-level) and stay in
 *   scope: they cannot be mapped to a diff line.
 * - Findings on a touched path stay in scope when they have no line number
 *   (file-level rules describe the path as a whole, and deletion counts as
 *   touching it — this keeps history findings about a deleted file in scope).
 * - Line-anchored findings stay in scope only on added lines. Added and
 *   untracked files count every line as changed; lines on deleted files or
 *   unchanged paths cannot be proven to touch the diff and move to `excluded`.
 * - Excluded findings keep their evidence intact; the review reports the
 *   omitted count.
 */
export function filterFindingsToDiff(
  findings: readonly Finding[],
  changes: readonly ChangedPath[],
  changedLines: ChangedLines | undefined,
  options: DiffFilterOptions = {},
): DiffFilterResult {
  if (options.allFindings === true) {
    return {
      included: [...findings].sort(compareFindings),
      excluded: [],
      linePrecision: changedLines !== undefined,
    };
  }

  const linePrecision = changedLines !== undefined;
  const changedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  for (const change of changes) {
    if (change.status === "deleted") {
      deletedPaths.add(change.path);
      continue;
    }
    changedPaths.add(change.path);
    if (
      (change.status === "renamed" || change.status === "copied") &&
      change.previousPath !== undefined
    ) {
      changedPaths.add(change.previousPath);
    }
  }

  const included: Finding[] = [];
  const excluded: Finding[] = [];

  for (const finding of findings) {
    if (finding.location === undefined) {
      included.push(finding);
      continue;
    }
    const { path, line } = finding.location;
    const touched = changedPaths.has(path) || deletedPaths.has(path);
    if (!touched) {
      excluded.push(finding);
      continue;
    }
    if (line === undefined) {
      included.push(finding);
      continue;
    }
    if (deletedPaths.has(path)) {
      // A line-anchored finding on a deleted file cannot be mapped to the
      // diff; only file-level findings about the deletion stay in scope.
      excluded.push(finding);
      continue;
    }
    if (!linePrecision) {
      included.push(finding);
      continue;
    }
    const lines = changedLines?.get(path);
    if (lines === undefined) {
      // Changed path with no recorded added lines (deletion-only change or a
      // binary/unsupported diff): a line-anchored finding cannot be proven to
      // touch the diff, so it stays out of the review rather than being
      // guessed in scope.
      excluded.push(finding);
      continue;
    }
    if (lines === "all" || lines.has(line)) {
      included.push(finding);
    } else {
      excluded.push(finding);
    }
  }

  return {
    included: included.sort(compareFindings),
    excluded: excluded.sort(compareFindings),
    linePrecision,
  };
}
