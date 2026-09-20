import { createFingerprint, type Finding } from "../../../core/findings.js";
import type { OsvAdvisory, OsvPackageAdvisories } from "./osv.js";

export const ADVISORIES_DOCTOR_ID = "security/advisories";
export const VULNERABLE_DEPENDENCY_RULE = `${ADVISORIES_DOCTOR_ID}/vulnerable-dependency`;

const SEVERITY_BY_ADVISORY: Record<OsvAdvisory["severity"], Finding["severity"]> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "medium",
};

export interface AdvisoryFindingInput {
  readonly lockPath: string;
  readonly advisories: readonly OsvPackageAdvisories[];
  readonly changed: boolean;
}

export function advisoryFinding(input: AdvisoryFindingInput, advisoryInput: OsvPackageAdvisories, advisory: OsvAdvisory): Finding {
  const pkg = advisoryInput.package;
  const location = { path: input.lockPath };
  const aliases = advisory.aliases.length > 0 ? `; aliases ${advisory.aliases.join(", ")}` : "";
  const fixed = advisory.fixedIn === undefined ? "" : `; fixed in ${advisory.fixedIn}`;

  return {
    ruleId: VULNERABLE_DEPENDENCY_RULE,
    doctorId: ADVISORIES_DOCTOR_ID,
    severity: SEVERITY_BY_ADVISORY[advisory.severity],
    confidence: "high",
    category: "security",
    title: `Resolved dependency has a published advisory: ${pkg.name}`,
    message: `Resolved dependency ${pkg.name}@${pkg.version} matches advisory ${advisory.id}: ${advisory.summary}`,
    location,
    evidence: [
      {
        type: "observation",
        detail: `package ${pkg.name}@${pkg.version}; advisory ${advisory.id}${aliases}; advisory severity ${advisory.severity}${fixed}`,
      },
    ],
    impact:
      "Installing this resolved version can introduce a known vulnerability that the advisory source tracks.",
    remediationConstraints: [
      "Upgrade through the repository's authorized package-manager workflow outside Codebase Doctor.",
      "Confirm runtime and API compatibility before changing the dependency version.",
      "Do not expose credentials while updating dependency metadata.",
    ],
    remediation:
      advisory.fixedIn === undefined
        ? `Have an authorized human or external coding agent upgrade ${pkg.name} to a version that addresses ${advisory.id}, then rerun the same audit scope with --with-advisories.`
        : `Have an authorized human or external coding agent upgrade ${pkg.name} to ${advisory.fixedIn} or later, then rerun the same audit scope with --with-advisories.`,
    verification: {
      command: input.changed
        ? "codebase-doctor audit . --changed --format json --with-advisories"
        : "codebase-doctor audit . --format json --with-advisories",
      expected:
        "The finding fingerprint is absent and security/advisories coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: ADVISORIES_DOCTOR_ID,
      ruleId: VULNERABLE_DEPENDENCY_RULE,
      location,
      identity: `${pkg.name}@${pkg.version}:${advisory.id}`,
    }),
  };
}

export function advisoryFindings(input: AdvisoryFindingInput): Finding[] {
  const findings: Finding[] = [];

  for (const advisoryInput of input.advisories) {
    for (const advisory of advisoryInput.advisories) {
      findings.push(advisoryFinding(input, advisoryInput, advisory));
    }
  }

  return findings;
}
