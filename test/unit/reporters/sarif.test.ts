import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../../src/core/normalize.js";
import { renderSarifReport } from "../../../src/reporters/sarif.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function result(): ScanResult {
  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: "0.1.1" },
    repository: { root: "/repo" },
    auditScope: fullAuditScope(),
    projects: [],
    plannedChecks: [],
    doctorRuns: [],
    findings: [{
      ruleId: "repository/invalid-manifest",
      doctorId: "project",
      severity: "high",
      confidence: "high",
      category: "repository",
      title: "Invalid package manifest",
      message: "package.json could not be parsed.",
      location: { path: "config/package #1.json", line: 2, column: 4 },
      evidence: [{ type: "manifest", path: "package.json", detail: "Unexpected token" }],
      impact: "Dependency and project detection may be incomplete or incorrect.",
      remediationConstraints: ["Preserve the intended package metadata."],
      remediation: "Correct the JSON syntax.",
      verification: {
        command: "codebase-doctor audit . --format json",
        expected: "The fingerprint is absent and applicable audit coverage is completed.",
      },
      fingerprint: "stable-fingerprint",
    }],
    summary: {
      total: 1,
      counts: { info: 0, low: 0, medium: 0, high: 1, critical: 0 },
      highestSeverity: "high",
    },
    comparison: {
      new: ["stable-fingerprint"],
      unchanged: [],
      resolved: [],
      newSummary: {
        total: 1,
        counts: { info: 0, low: 0, medium: 0, high: 1, critical: 0 },
        highestSeverity: "high",
      },
    },
  };
}

describe("SARIF reporter", () => {
  it("maps findings, locations, fingerprints, and baseline state", () => {
    const report = JSON.parse(renderSarifReport(result()));
    const run = report.runs[0];
    const finding = run.results[0];

    expect(report.version).toBe("2.1.0");
    expect(run.tool.driver.rules[0].id).toBe("repository/invalid-manifest");
    expect(finding).toMatchObject({
      ruleId: "repository/invalid-manifest",
      level: "error",
      baselineState: "new",
      partialFingerprints: { codebaseDoctorFingerprint: "stable-fingerprint" },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: "config/package%20%231.json" },
        region: { startLine: 2, startColumn: 4 },
      } }],
      properties: { category: "repository", confidence: "high" },
    });
    expect(finding.properties).toMatchObject({
      impact: "Dependency and project detection may be incomplete or incorrect.",
      remediationConstraints: ["Preserve the intended package metadata."],
      remediation: "Correct the JSON syntax.",
      verification: {
        command: "codebase-doctor audit . --format json",
        expected: expect.stringContaining("coverage is completed"),
      },
    });
    expect(run.tool.driver.rules[0].help.text).toBe("Correct the JSON syntax.");
  });

  it("keeps database evidence on a locationless result", () => {
    const { location: _location, ...baseFinding } = result().findings[0]!;
    const databaseResult: ScanResult = {
      ...result(),
      findings: [{
        ...baseFinding,
        ruleId: "database/rls/public-unconditional-write",
        doctorId: "database/rls",
        category: "database-security",
        evidence: [{
          type: "database",
          schema: "public",
          table: "documents",
          policy: "public write",
          detail: "The policy predicate is unconditional.",
        }],
      }],
    };

    const finding = JSON.parse(renderSarifReport(databaseResult)).runs[0].results[0];

    expect(finding.locations).toBeUndefined();
    expect(finding.properties.evidence).toEqual([
      expect.objectContaining({ type: "database", schema: "public", table: "documents" }),
    ]);
  });

  it("stores full changed audit scope alongside coverage without creating results", () => {
    const covered: ScanResult = {
      ...result(),
      findings: [],
      auditScope: {
        mode: "changed",
        base: { kind: "merge-base", requestedRef: "main", resolvedCommit: "1234567890abcdef" },
        changes: [{ status: "renamed", path: "src/new.ts", previousPath: "src/old.ts" }],
        affectedProjectIds: ["root"],
        reasons: [{ projectId: "root", reason: "direct-change", source: "src/new.ts" }],
        limitations: ["Unchanged files were not independently re-audited."],
      },
      coverage: [{
        moduleId: "database/sql-rls",
        status: "partial",
        scope: "root:migrations",
        filesExamined: 1,
        statementsExamined: 2,
        statementsRecognized: 1,
        limitations: ["Dynamic SQL was not evaluated."],
      }],
    };

    const run = JSON.parse(renderSarifReport(covered)).runs[0];

    expect(run.results).toEqual([]);
    expect(run.properties.coverage).toEqual(covered.coverage);
    expect(run.properties.auditScope).toEqual(covered.auditScope);
  });
});
