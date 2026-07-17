import {
  createFingerprint,
  sortFindings,
  type Evidence,
  type Finding,
} from "../../../core/findings.js";
import type {
  AuditReport,
  Finding as RlsFinding,
  SchemaFinding,
} from "./types.js";

const DOCTOR_ID = "database/rls";

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
    impact: `The database condition "${finding.title}" can weaken the intended access-control boundary.`,
    remediationConstraints: [
      "Preserve least-privilege database access; live re-verification requires separately authorized database access.",
      "The remediated database policy set must preserve the intended role and row-access boundary.",
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
