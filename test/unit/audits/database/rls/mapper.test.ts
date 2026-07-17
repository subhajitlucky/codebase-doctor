import { describe, expect, it } from "vitest";
import { analyzeCatalog } from "../../../../../src/audits/database/rls/analyzer.js";
import { mapRlsReport } from "../../../../../src/audits/database/rls/mapper.js";
import type {
  AuditReport,
  CatalogSnapshot,
  Finding as RlsFinding,
  RlsFindingId,
  SchemaFinding,
} from "../../../../../src/audits/database/rls/types.js";

const TABLE_RULE_IDS = [
  "reachable-truncate",
  "rls-disabled-exposed",
  "rls-disabled",
  "rls-enabled-no-policies",
  "force-rls-disabled",
  "multiple-permissive-policies",
  "public-unconditional-read",
  "public-unconditional-write",
  "write-policy-missing-check",
  "public-permissive-policy",
] as const satisfies readonly RlsFindingId[];

const SCHEMA_RULE_IDS = [
  "broad-default-table-privilege",
  "rls-bypass-role",
] as const satisfies readonly RlsFindingId[];

function reportWithEveryRule(): AuditReport {
  const tableFindings: RlsFinding[] = TABLE_RULE_IDS.map((id) => ({
    id,
    severity: "high",
    schema: "public",
    table: "documents",
    title: id,
    detail: `detail:${id}`,
    recommendation: `recommendation:${id}`,
  }));
  const schemaFindings: SchemaFinding[] = SCHEMA_RULE_IDS.map((id) => ({
    id,
    severity: "high",
    schema: id === "rls-bypass-role" ? null : "public",
    title: id,
    detail: `detail:${id}`,
    recommendation: `recommendation:${id}`,
  }));
  return {
    schemaVersion: "1.0",
    generatedAt: new Date(0).toISOString(),
    schemas: ["public"],
    summary: {
      tables: 1,
      policies: 0,
      findings: { info: 0, low: 0, medium: 0, high: 12, critical: 0 },
      highestSeverity: "high",
    },
    schemaFindings,
    tables: [{
      schema: "public",
      table: "documents",
      rlsEnabled: true,
      forceRls: true,
      policies: [],
      findings: tableFindings,
    }],
  };
}

function riskyCatalog(): CatalogSnapshot {
  return {
    tables: [{
      schema: "public",
      name: "documents",
      owner: "postgres",
      rlsEnabled: true,
      forceRls: true,
      isPartitioned: false,
      estimatedRows: null,
    }],
    policies: [{
      schema: "public",
      table: "documents",
      name: "public write",
      command: "INSERT",
      permissive: true,
      roles: ["anon"],
      usingExpression: null,
      checkExpression: "true",
    }],
    relationPrivileges: [],
    defaultPrivileges: [],
    schemaPrivileges: [],
    roles: [],
    roleMemberships: [],
  };
}

describe("mapRlsReport", () => {
  it("maps table findings into namespaced database findings", () => {
    const report = analyzeCatalog(riskyCatalog(), { schemas: ["public"] });
    const mapped = mapRlsReport(report);
    const finding = mapped.find(({ ruleId }) =>
      ruleId === "database/rls/public-unconditional-write"
    );

    expect(finding).toMatchObject({
      ruleId: "database/rls/public-unconditional-write",
      doctorId: "database/rls",
      severity: "critical",
      confidence: "high",
      category: "database-security",
      evidence: [{
        type: "database",
        schema: "public",
        table: "documents",
      }],
    });
    expect(finding?.location).toBeUndefined();
    expect(finding?.remediation).toContain("Suggested SQL:");
    expect(finding).toMatchObject({
      impact: expect.any(String),
      remediationConstraints: expect.arrayContaining([
        expect.stringContaining("Application writes"),
        expect.stringContaining("separately authorized access"),
      ]),
      verification: {
        command: "codebase-doctor audit . --database-schema public --with-database --json",
        expected: expect.stringMatching(/fingerprint.*absent.*coverage.*completed.*public/i),
      },
    });
  });

  it("maps schema findings without inventing a table", () => {
    const report = analyzeCatalog({
      ...riskyCatalog(),
      tables: [],
      policies: [],
      defaultPrivileges: [{
        schema: "public",
        owner: "postgres",
        grantee: "PUBLIC",
        objectType: "TABLE",
        privilege: "DELETE",
        grantable: false,
      }],
    }, { schemas: ["public"] });

    const finding = mapRlsReport(report)[0];

    expect(finding).toMatchObject({
      ruleId: "database/rls/broad-default-table-privilege",
      evidence: [{ type: "database", schema: "public" }],
    });
    expect(finding?.evidence[0]).not.toHaveProperty("table");
  });

  it("keeps fingerprints stable across generated timestamps", () => {
    const first = analyzeCatalog(riskyCatalog(), {
      schemas: ["public"],
      generatedAt: new Date(0),
    });
    const second = analyzeCatalog(riskyCatalog(), {
      schemas: ["public"],
      generatedAt: new Date(1_000_000),
    });

    expect(mapRlsReport(second).map(({ fingerprint }) => fingerprint)).toEqual(
      mapRlsReport(first).map(({ fingerprint }) => fingerprint),
    );
  });

  it("provides nonempty specific guidance for every live catalog rule", () => {
    const mapped = mapRlsReport(reportWithEveryRule());

    expect(mapped).toHaveLength(12);
    expect(mapped.every((finding) =>
      finding.impact !== undefined && finding.impact.trim().length > 0 &&
      finding.remediationConstraints !== undefined &&
      finding.remediationConstraints.length > 0 &&
      finding.remediationConstraints.every((constraint) => constraint.trim().length > 0) &&
      finding.verification?.command ===
        "codebase-doctor audit . --database-schema public --with-database --json" &&
      /fingerprint.*absent.*coverage.*completed/i.test(finding.verification.expected)
    )).toBe(true);

    const byRule = new Map(mapped.map((finding) => [finding.ruleId, finding]));
    expect(byRule.get("database/rls/public-unconditional-write")?.impact)
      .toMatch(/write|rows/i);
    expect(byRule.get("database/rls/write-policy-missing-check")?.remediationConstraints?.join(" "))
      .toMatch(/WITH CHECK/i);
    expect(byRule.get("database/rls/rls-disabled-exposed")?.impact)
      .toMatch(/direct application grants.*without.*RLS/i);
    expect(byRule.get("database/rls/force-rls-disabled")?.remediationConstraints?.join(" "))
      .toMatch(/owner|FORCE RLS/i);
    expect(byRule.get("database/rls/reachable-truncate")?.impact)
      .toMatch(/TRUNCATE bypasses RLS/i);
    expect(byRule.get("database/rls/broad-default-table-privilege")?.impact)
      .toMatch(/future tables|default privilege/i);
    expect(byRule.get("database/rls/broad-default-table-privilege")?.remediationConstraints?.join(" "))
      .not.toMatch(/policy set/i);
    expect(byRule.get("database/rls/rls-bypass-role")?.impact)
      .toMatch(/bypass/i);
    expect(byRule.get("database/rls/rls-bypass-role")?.remediationConstraints?.join(" "))
      .toMatch(/role membership|BYPASSRLS/i);
    expect(byRule.get("database/rls/rls-enabled-no-policies")?.impact).toBe(
      "RLS default-denies non-owner access when no policies exist; any required non-owner workflow may fail.",
    );
    expect(byRule.get("database/rls/rls-enabled-no-policies")?.remediationConstraints?.join(" "))
      .toContain("add a policy only for a confirmed required non-owner workflow");
  });

  it("re-verifies the complete audited schema set for table and schema-less findings", () => {
    const report = reportWithEveryRule();
    const mapped = mapRlsReport({
      ...report,
      schemas: ["private", "tenant $(touch nope)", "public"],
    });
    const expectedCommand =
      "codebase-doctor audit . --database-schema private --database-schema 'tenant $(touch nope)' " +
      "--database-schema public --with-database --json";

    for (const ruleId of ["database/rls/public-unconditional-write", "database/rls/rls-bypass-role"]) {
      const finding = mapped.find((candidate) => candidate.ruleId === ruleId);
      expect(finding?.verification?.command).toBe(expectedCommand);
      expect(finding?.verification?.expected).toContain("private, tenant $(touch nope), public");
      expect(finding?.remediationConstraints?.join(" ")).toMatch(
        /separately authorized.*same audited schema set.*private, tenant \$\(touch nope\), public/i,
      );
    }
    expect(expectedCommand).not.toContain("--database-schema tenant $(touch nope)");
    expect(expectedCommand).not.toMatch(/postgres|password|credential/i);
  });
});
