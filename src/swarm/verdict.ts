import type { DomainCoverage } from "../core/domain-coverage.js";

/**
 * Mission-level verdict algebra for the verifier swarm. Four states, ordered
 * from worst to best:
 *
 *   findings — gating findings are present; actionable now.
 *   unknown  — evidence was lost or analysis could not complete (failed or
 *              partial domains, failed workers). Never reported as clean.
 *   gaps     — no findings and no lost evidence, but some domains were not
 *              attempted (unsupported, skipped, not-selected by design).
 *              A clean result with receipts attached, not a full proof.
 *   verified — every applicable domain completed or was not applicable.
 */
export type RepoVerdict = "findings" | "unknown" | "gaps" | "verified";

export const VERDICT_PRIORITY: Record<RepoVerdict, number> = {
  findings: 3,
  unknown: 2,
  gaps: 1,
  verified: 0,
};

export interface RepoVerdictComposition {
  verdict: RepoVerdict;
  unknownDomains: string[];
  gapDomains: string[];
}

export function composeRepoVerdict(
  domains: readonly DomainCoverage[],
  findingCount: number,
  failedDoctorRuns: number,
): RepoVerdictComposition {
  const unknownDomains = domains
    .filter((domain) => domain.status === "failed" || domain.status === "partial")
    .map((domain) => `${domain.domain}: ${domain.status}`)
    .sort();
  const gapDomains = domains
    .filter((domain) =>
      domain.status === "unsupported" ||
      domain.status === "skipped" ||
      domain.status === "not-selected")
    .map((domain) => `${domain.domain}: ${domain.status}`)
    .sort();

  const verdict: RepoVerdict =
    findingCount > 0
      ? "findings"
      : unknownDomains.length > 0 || failedDoctorRuns > 0
        ? "unknown"
        : gapDomains.length > 0
          ? "gaps"
          : "verified";

  return { verdict, unknownDomains, gapDomains };
}

export function composeFleetVerdict(verdicts: readonly RepoVerdict[]): RepoVerdict {
  if (verdicts.length === 0) return "verified";
  return [...verdicts].sort((left, right) => VERDICT_PRIORITY[right] - VERDICT_PRIORITY[left])[0]!;
}
