import {
  createFingerprint,
  type Evidence,
  type Finding,
} from "../../../core/findings.js";
import type { ProbeFinding, ProbeReport } from "./types.js";

const DOCTOR_ID = "database/rls-probe";

const IMPACTS: Record<string, string> = {
  "probe-cross-subject-read":
    "An application identity can read rows belonging to another user, so tenant or user isolation is not enforced.",
  "probe-cross-owner-read":
    "An application role can read rows across multiple ownership or tenant boundaries.",
  "probe-session-dependent-policy":
    "A policy depends on middleware session state that the probe cannot reproduce, so a clean probe is not proof of isolation.",
  "probe-role-unavailable":
    "The audit connection cannot impersonate this role, so isolation for that identity remains unproven.",
  "probe-error":
    "The probe did not complete for this role and table, so isolation remains unproven.",
  "probe-read-denied":
    "This identity is denied access at the table privilege layer.",
  "probe-reads-no-rows":
    "This identity sees no rows, consistent with default-deny behavior.",
  "probe-reads-rows":
    "This identity can read rows and the access may be intentional.",
  "probe-subject-reads-own-rows":
    "This identity can read only its own rows in the sampled data.",
};

function evidenceFor(finding: ProbeFinding): readonly Evidence[] {
  if (finding.schema === null) {
    return [{ type: "observation", detail: finding.detail }];
  }
  return [{
    type: "database",
    schema: finding.schema,
    ...(finding.table === null ? {} : { table: finding.table }),
    detail: finding.detail,
  }];
}

function remediationConstraints(finding: ProbeFinding): readonly string[] {
  if (finding.id === "probe-role-unavailable") {
    return [
      "The audit connection must be able to impersonate the intended application role without modifying the database.",
      "Do not use a superuser merely to hide a missing role-membership configuration.",
    ];
  }
  if (finding.id === "probe-session-dependent-policy") {
    return [
      "The probe must reproduce every session setting the policy depends on, or isolation remains unproven.",
      "Do not weaken the policy solely to make the probe pass.",
    ];
  }
  return [
    "The application identity must remain unable to read rows outside its ownership or tenant boundary.",
    "Do not disable RLS or grant broader table access to make the probe pass.",
  ];
}

export function mapProbeFindings(report: ProbeReport): Finding[] {
  return report.findings.map((finding) => {
    const ruleId = `${DOCTOR_ID}/${finding.id}`;
    return {
      ruleId,
      doctorId: DOCTOR_ID,
      severity: finding.severity,
      confidence: finding.id.startsWith("probe-cross-") ? "high" : "medium",
      category: "database-security",
      title: finding.title,
      message: finding.detail,
      evidence: evidenceFor(finding),
      impact: IMPACTS[finding.id] ?? "The live RLS probe reported an access result that needs review.",
      remediationConstraints: remediationConstraints(finding),
      remediation: finding.recommendation,
      verification: {
        command:
          "codebase-doctor audit . --with-database --probe-db --app-roles <role> --json",
        expected:
          "This fingerprint is absent and live RLS probe coverage is completed for the same schema and role set.",
      },
      fingerprint: createFingerprint({
        doctorId: DOCTOR_ID,
        ruleId,
        identity: JSON.stringify([
          finding.schema,
          finding.table,
          ...finding.identity,
        ]),
      }),
    };
  });
}
