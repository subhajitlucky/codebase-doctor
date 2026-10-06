import type { FileRecord } from "../workspace/types.js";
import type { ChangedPath } from "./types.js";

export interface ChangedCandidateSelection {
  /** Changed paths present in the inventory and matching the doctor, sorted. */
  readonly candidates: readonly string[];
  readonly limitations: readonly string[];
}

/**
 * Narrows a doctor's candidate files to the changed scope: only changed
 * paths that are still inventoried regular files are examined. Deleted paths
 * and changed paths outside the inventory become explicit limitations instead
 * of silent skips, so a changed audit never implies unchanged files were
 * re-audited.
 *
 * @param isCandidate the doctor's own file-type predicate, applied to
 * changed paths so limitations name only relevant files.
 * @param label short doctor label used in limitation messages.
 */
export function selectChangedCandidates(
  changes: readonly ChangedPath[],
  files: readonly FileRecord[],
  isCandidate: (path: string) => boolean,
  label: string,
): ChangedCandidateSelection {
  const inventoried = new Set(
    files.filter((file) => file.kind === "file").map((file) => file.path),
  );
  const candidates = new Set<string>();
  const limitations: string[] = [];

  for (const change of changes) {
    if (!isCandidate(change.path)) continue;
    if (change.status === "deleted") {
      limitations.push(`${change.path}: deleted changed path could not be examined for ${label}.`);
      continue;
    }
    if (!inventoried.has(change.path)) {
      limitations.push(`${change.path}: changed path is not an inventoried regular file for ${label}.`);
      continue;
    }
    candidates.add(change.path);
  }

  return {
    candidates: [...candidates].sort(),
    limitations: [...new Set(limitations)].sort(),
  };
}
