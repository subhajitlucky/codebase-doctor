import {
  createFingerprint,
  sortFindings,
  type Evidence,
  type Finding,
} from "../../../core/findings.js";
import type {
  AuditReport,
  Finding as RlsFinding,
  RlsFindingId,
  SchemaFinding,
} from "./types.js";

const DOCTOR_ID = "database/rls";
const LIVE_DATABASE_PERMISSION =
  "Live re-verification requires separately authorized database access; the command conveys no credentials.";

interface LiveGuidance {
  readonly impact: string;
  readonly remediationConstraints: readonly string[];
}

const LIVE_GUIDANCE = {
  "reachable-truncate": {
    impact: "An application-facing role can remove every row because TRUNCATE bypasses RLS policies.",
    remediationConstraints: [
      "Application-facing roles must not retain TRUNCATE; any maintenance privilege must remain isolated.",
    ],
  },
  "rls-disabled-exposed": {
    impact: "Direct application grants can reach table rows without any RLS filtering.",
    remediationConstraints: [
      "Application row access must be protected by enabled RLS and least-privilege grants.",
    ],
  },
  "rls-disabled": {
    impact: "The table has no RLS enforcement if application access is introduced now or later.",
    remediationConstraints: [
      "Tables intended for row-isolated application access must have RLS enabled before access is granted.",
    ],
  },
  "rls-enabled-no-policies": {
    impact: "Required non-owner operations are denied because enabled RLS has no policies to authorize them.",
    remediationConstraints: [
      "Each required application operation must have an explicit least-privilege policy; unspecified access remains denied.",
    ],
  },
  "force-rls-disabled": {
    impact: "Table-owner sessions can bypass RLS even though other roles are filtered by policies.",
    remediationConstraints: [
      "Owner workflows must either pass through FORCE RLS or retain an explicitly reviewed owner-bypass exception.",
    ],
  },
  "multiple-permissive-policies": {
    impact: "OR-combined permissive policies can authorize rows beyond the apparent scope of each policy alone.",
    remediationConstraints: [
      "The effective union of permissive predicates must preserve the intended role and command boundary.",
    ],
  },
  "public-unconditional-read": {
    impact: "A public-like role can read every row selected by the policy without a row predicate.",
    remediationConstraints: [
      "Public reads must remain limited by an explicit, reviewed content, ownership, or tenant predicate.",
    ],
  },
  "public-unconditional-write": {
    impact: "A public-like role can insert, update, or delete rows without an ownership or tenant boundary.",
    remediationConstraints: [
      "Application writes must enforce authenticated ownership or tenant invariants in USING and WITH CHECK as applicable.",
    ],
  },
  "write-policy-missing-check": {
    impact: "Inserted or updated row values can escape the access boundary enforced when existing rows are selected.",
    remediationConstraints: [
      "Every INSERT or UPDATE path must enforce its ownership or tenant invariant on the resulting row with WITH CHECK.",
    ],
  },
  "public-permissive-policy": {
    impact: "A permissive public policy can broaden access when its predicate is OR-combined with other policies.",
    remediationConstraints: [
      "The public role assignment and effective permissive-policy union must preserve least-privilege access.",
    ],
  },
  "broad-default-table-privilege": {
    impact: "Future tables can automatically inherit broad application or PUBLIC privileges at creation time.",
    remediationConstraints: [
      "Default privileges for the affected owner and schema must not grant unintended access to future tables.",
    ],
  },
  "rls-bypass-role": {
    impact: "An application role can inherit or assume a role that bypasses all RLS enforcement.",
    remediationConstraints: [
      "Application role membership must not inherit or permit assuming SUPERUSER or BYPASSRLS capabilities.",
    ],
  },
} as const satisfies Readonly<Record<RlsFindingId, LiveGuidance>>;

function remediation(
  recommendation: string,
  suggestedSql: readonly string[] | undefined,
): string {
  if (suggestedSql === undefined || suggestedSql.length === 0) return recommendation;
  return `${recommendation}\n\nSuggested SQL:\n${suggestedSql.join("\n")}`;
}

function mappedFinding(
  finding: RlsFinding | SchemaFinding,
  table: string | undefined,
): Finding {
  const schema = finding.schema ?? "<database>";
  const ruleId = `${DOCTOR_ID}/${finding.id}`;
  const guidance = LIVE_GUIDANCE[finding.id];
  const evidence: Evidence = {
    type: "database",
    schema,
    ...(table === undefined ? {} : { table }),
    detail: finding.detail,
  };

  return {
    ruleId,
    doctorId: DOCTOR_ID,
    severity: finding.severity,
    confidence: "high",
    category: "database-security",
    title: finding.title,
    message: finding.detail,
    evidence: [evidence],
    impact: guidance.impact,
    remediationConstraints: [
      ...guidance.remediationConstraints,
      LIVE_DATABASE_PERMISSION,
    ],
    remediation: remediation(finding.recommendation, finding.suggestedSql),
    verification: {
      command: "codebase-doctor audit . --with-database --format json",
      expected: "This fingerprint is absent and applicable live database audit coverage is completed.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId,
      identity: JSON.stringify([schema, table ?? null, finding.id, finding.detail]),
    }),
  };
}

export function mapRlsReport(report: AuditReport): Finding[] {
  return sortFindings([
    ...report.schemaFindings.map((finding) => mappedFinding(finding, undefined)),
    ...report.tables.flatMap((table) =>
      table.findings.map((finding) => mappedFinding(finding, table.table))
    ),
  ]);
}
