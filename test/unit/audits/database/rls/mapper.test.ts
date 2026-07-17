import { describe, expect, it } from "vitest";
import { analyzeCatalog } from "../../../../../src/audits/database/rls/analyzer.js";
import { mapRlsReport } from "../../../../../src/audits/database/rls/mapper.js";
import type { CatalogSnapshot } from "../../../../../src/audits/database/rls/types.js";

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
        expect.stringContaining("database"),
        expect.stringContaining("row-access boundary"),
      ]),
      verification: {
        command: "codebase-doctor audit . --with-database --format json",
        expected: expect.stringMatching(/fingerprint.*absent.*coverage.*completed/i),
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
});
