import {
  hasFindingAtOrAbove,
  type FindingThreshold,
} from "../core/summary.js";
import type { Finding } from "../core/findings.js";

export type ReviewVerdict = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export const REVIEW_VERDICTS = ["APPROVE", "COMMENT", "REQUEST_CHANGES"] as const;

/**
 * Decide the review verdict from the in-scope (diff-filtered) findings.
 *
 * - `REQUEST_CHANGES` when at least one in-scope finding meets the failure
 *   threshold.
 * - `COMMENT` when in-scope findings exist below the threshold.
 * - `APPROVE` when nothing in the diff was flagged.
 *
 * Coverage incompleteness never changes the verdict; it is reported alongside
 * it and, with `--require-complete`, fails the exit code instead.
 */
export function decideReviewVerdict(
  findingsInScope: readonly Finding[],
  failOn: FindingThreshold,
): ReviewVerdict {
  if (hasFindingAtOrAbove(findingsInScope, failOn)) return "REQUEST_CHANGES";
  if (findingsInScope.length > 0) return "COMMENT";
  return "APPROVE";
}

/**
 * Select the findings that gate the verdict and the exit code. With a
 * baseline comparison, only new in-diff findings can fail the review, mirroring
 * `classifyScanExit` semantics on the narrowed set.
 */
export function selectVerdictFindings(
  findingsInScope: readonly Finding[],
  newFingerprints: readonly string[] | undefined,
): readonly Finding[] {
  if (newFingerprints === undefined) return findingsInScope;
  const isNew = new Set(newFingerprints);
  return findingsInScope.filter((finding) => isNew.has(finding.fingerprint));
}

export interface ReviewExitOptions {
  readonly requireComplete?: boolean;
}

/**
 * Review exit codes reuse the CLI contract: `2` is an operational or
 * coverage failure, `1` means the review requests changes, `0` approves.
 */
export function classifyReviewExit(
  verdictFindings: readonly Finding[],
  failOn: FindingThreshold,
  doctorFailed: boolean,
  coverageComplete: boolean,
  options: ReviewExitOptions = {},
): 0 | 1 | 2 {
  if (doctorFailed) return 2;
  if (options.requireComplete === true && !coverageComplete) return 2;
  return hasFindingAtOrAbove(verdictFindings, failOn) ? 1 : 0;
}
