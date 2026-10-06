import type { Finding } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";
import type { FindingThreshold } from "../core/summary.js";
import type { ChangedLines } from "./changed-lines.js";
import { filterFindingsToDiff } from "./filter.js";
import {
  decideReviewVerdict,
  selectVerdictFindings,
  type ReviewVerdict,
} from "./verdict.js";

export interface ReviewSummary {
  readonly verdict: ReviewVerdict;
  readonly included: Finding[];
  readonly excluded: Finding[];
  readonly linePrecision: boolean;
  /** The in-diff findings that gate the verdict (new-only with a baseline). */
  readonly verdictFindings: readonly Finding[];
  readonly baselineFiltered: boolean;
}

/**
 * Shared review core for the `review` CLI command and the `review_changes`
 * MCP tool: narrow a changed-scope audit result to the diff and decide the
 * verdict. Findings outside the diff are omitted, never resolved.
 */
export function summarizeReview(
  result: ScanResult,
  changedLines: ChangedLines | undefined,
  failOn: FindingThreshold,
  options: { allFindings: boolean | undefined } = { allFindings: undefined },
): ReviewSummary {
  const filtered = filterFindingsToDiff(
    result.findings,
    result.auditScope.changes,
    changedLines,
    options.allFindings === true ? { allFindings: true } : {},
  );
  const baselineFiltered = result.comparison !== undefined;
  const verdictFindings = selectVerdictFindings(filtered.included, result.comparison?.new);
  return {
    verdict: decideReviewVerdict(verdictFindings, failOn),
    included: filtered.included,
    excluded: filtered.excluded,
    linePrecision: filtered.linePrecision,
    verdictFindings,
    baselineFiltered,
  };
}
