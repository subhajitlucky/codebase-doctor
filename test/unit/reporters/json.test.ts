import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../../src/core/normalize.js";
import { renderJsonReport } from "../../../src/reporters/json.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function result(): ScanResult {
  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: "0.1.0" },
    repository: { root: "/repo" },
    auditScope: fullAuditScope(),
    projects: [],
    plannedChecks: [],
    domainCoverage: [{
      domain: "security",
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
      evidence: [],
      modules: [],
      limitations: ["General security analysis is not implemented."],
    }],
    doctorRuns: [{
      doctorId: "broken",
      status: "failed",
      durationMs: 3,
      findingCount: 0,
      error: { code: "doctor_execution_failed", message: "boom" },
      skipReason: null,
      checkRuns: [],
    }],
    coverage: [{
      moduleId: "database/sql-rls",
      status: "partial",
      scope: "root:migrations",
      filesExamined: 1,
      statementsExamined: 2,
      statementsRecognized: 1,
      limitations: ["Dynamic SQL was not evaluated."],
    }],
    findings: [
      {
        ruleId: "high-rule",
        doctorId: "fixture",
        severity: "high",
        confidence: "high",
        category: "fixture",
        title: "High finding",
        message: "High message",
        evidence: [{ type: "observation", detail: "high" }],
        impact: "A high-impact validation issue remains.",
        remediationConstraints: ["Preserve existing public behavior."],
        remediation: "Correct the validation issue.",
        verification: {
          command: "codebase-doctor audit . --format json",
          expected: "The fingerprint is absent and applicable audit coverage is completed.",
        },
        fingerprint: "high",
      },
      {
        ruleId: "info-rule",
        doctorId: "fixture",
        severity: "info",
        confidence: "medium",
        category: "fixture",
        title: "Info finding",
        message: "Info message",
        evidence: [],
        fingerprint: "info",
      },
    ],
    summary: {
      total: 2,
      counts: { info: 1, low: 0, medium: 0, high: 1, critical: 0 },
      highestSeverity: "high",
    },
  };
}

describe("JSON reporter", () => {
  it("preserves safe Drizzle Date evidence and bounded coverage without source disclosure", () => {
    const drizzleResult = result();
    drizzleResult.coverageSummary = { total: 3, emitted: 2, omitted: 1 };
    drizzleResult.coverage = [{
      moduleId: "database/drizzle",
      status: "partial",
      scope: "full",
      filesExamined: 2,
      statementsExamined: 40,
      statementsRecognized: 1,
      limitations: ["One supported Date flow could not be classified."],
      limitationGroups: [{
        reason: "A supported Date flow could not be classified.",
        total: 2,
        samplePaths: ["src/query.ts"],
        omittedPathCount: 1,
      }],
      limitationSummary: { total: 2, emitted: 1, omitted: 1 },
    }];
    drizzleResult.findings = [{
      ruleId: "database/drizzle/raw-sql-date-parameter",
      doctorId: "database/drizzle",
      severity: "medium",
      confidence: "high",
      category: "database",
      title: "Raw Drizzle SQL receives an unencoded Date value",
      message: "A statically proven JavaScript Date reaches a raw Drizzle SQL parameter.",
      location: { path: "src/query.ts", line: 12, column: 18 },
      evidence: [{
        type: "file",
        path: "src/query.ts",
        detail: "A constructed-date value is interpolated through the imported Drizzle sql binding 'dbSql'; source and parameter content were withheld.",
      }],
      impact: "postgres-js can reject an unencoded Date parameter at runtime.",
      remediationConstraints: [
        "Only an authorized human or external coding agent may change target repository files.",
      ],
      remediation: "Have an authorized external actor use lte(column, date), or supply a proven explicit encoder.",
      verification: {
        command: "codebase-doctor audit . --json",
        expected: "The fingerprint is absent and database/drizzle coverage completed for the same scope.",
      },
      fingerprint: "drizzle-date-fingerprint",
    }];

    const serialized = renderJsonReport(drizzleResult);
    const parsed = JSON.parse(serialized);

    expect(parsed.findings[0]).toMatchObject({
      ruleId: "database/drizzle/raw-sql-date-parameter",
      doctorId: "database/drizzle",
      severity: "medium",
      confidence: "high",
      location: { path: "src/query.ts", line: 12, column: 18 },
      evidence: [{
        path: "src/query.ts",
        detail: expect.stringContaining("sql binding 'dbSql'"),
      }],
      remediation: expect.stringMatching(/lte\(column, date\).*explicit encoder/i),
      verification: { command: "codebase-doctor audit . --json" },
    });
    expect(parsed.coverageSummary).toEqual({ total: 3, emitted: 2, omitted: 1 });
    expect(parsed.coverage[0]).toMatchObject({
      moduleId: "database/drizzle",
      limitationGroups: [{ total: 2, omittedPathCount: 1 }],
      limitationSummary: { total: 2, emitted: 1, omitted: 1 },
    });
    for (const withheld of [
      "select * from private_events where created_at <=",
      "dangerousDateValue",
      "2037-04-05T06:07:08.000Z",
      "sk-test-drizzle-report-secret",
    ]) expect(serialized).not.toContain(withheld);
  });

  it("preserves safe source-integrity evidence under schema version 1", () => {
    const sourceResult = result();
    sourceResult.findings = [{
      ...sourceResult.findings[0]!,
      ruleId: "source/import-target-missing",
      doctorId: "repository/source-integrity",
      category: "correctness",
      title: "Internal import target is missing",
      location: { path: "src/importer.ts", line: 3, column: 9 },
      evidence: [{
        type: "file",
        path: "src/importer.ts",
        detail: "Expected internal target src/missing.ts (static; proof: relative-explicit).",
      }],
      remediation: "Codebase Doctor does not modify files.",
      fingerprint: "source-fingerprint",
    }];

    const serialized = renderJsonReport(sourceResult);
    const parsed = JSON.parse(serialized);

    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "source/import-target-missing",
      doctorId: "repository/source-integrity",
      location: { path: "src/importer.ts", line: 3, column: 9 },
      evidence: [{ type: "file", path: "src/importer.ts" }],
      fingerprint: "source-fingerprint",
    });
    expect(serialized).not.toContain("sk-test-raw-import-specifier");
  });

  it("returns valid schema-versioned JSON with every severity count", () => {
    const parsed = JSON.parse(renderJsonReport(result()));

    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.summary.counts).toEqual({
      info: 1,
      low: 0,
      medium: 0,
      high: 1,
      critical: 0,
    });
  });

  it("preserves normalized ordering and stable null/array fields", () => {
    const parsed = JSON.parse(renderJsonReport(result()));

    expect(parsed.findings.map(({ ruleId }: { ruleId: string }) => ruleId)).toEqual([
      "high-rule",
      "info-rule",
    ]);
    expect(parsed.doctorRuns[0]).toMatchObject({
      status: "failed",
      skipReason: null,
      checkRuns: [],
    });
    expect(renderJsonReport(result())).not.toContain("undefined");
  });

  it("keeps operational failures distinct from code findings", () => {
    const parsed = JSON.parse(renderJsonReport(result()));

    expect(parsed.doctorRuns[0].error).toEqual({
      code: "doctor_execution_failed",
      message: "boom",
    });
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings.every(({ ruleId }: { ruleId: string }) =>
      ruleId !== "doctor_execution_failed",
    )).toBe(true);
  });

  it("keeps schema version 1 while emitting optional audit coverage", () => {
    const parsed = JSON.parse(renderJsonReport(result()));

    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.coverage).toEqual([expect.objectContaining({
      moduleId: "database/sql-rls",
      status: "partial",
      statementsRecognized: 1,
    })]);
    expect(parsed.domainCoverage).toEqual(result().domainCoverage);
  });

  it("preserves additive bounded-evidence totals under schema version 1", () => {
    const bounded: ScanResult = {
      ...result(),
      coverageSummary: { total: 1_500, emitted: 200, omitted: 1_300 },
      coverage: [{
        ...result().coverage![0]!,
        limitationGroups: [{
          reason: "relative source target is fixture-controlled.",
          total: 500,
          samplePaths: ["fixtures/a.ts"],
          omittedPathCount: 499,
        }],
        limitationSummary: { total: 500, emitted: 1, omitted: 499 },
      }],
    };
    const parsed = JSON.parse(renderJsonReport(bounded));

    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.coverageSummary).toEqual({ total: 1_500, emitted: 200, omitted: 1_300 });
    expect(parsed.coverage[0].limitationGroups[0]).toMatchObject({
      total: 500,
      omittedPathCount: 499,
    });
  });

  it("keeps schema version 1 while emitting optional bounded source impact", () => {
    const withImpact: ScanResult = {
      ...result(),
      sourceImpact: {
        mode: "changed",
        status: "completed",
        graphNodeCount: 2,
        graphEdgeCount: 1,
        externalBoundaryCount: 0,
        dynamicBoundaryCount: 0,
        changedSourcePaths: ["src/a.ts"],
        impactedFileCount: 1,
        impactedProjectIds: ["root"],
        impacts: [{
          path: "src/b.ts",
          projectId: "root",
          dependencyPath: ["src/a.ts", "src/b.ts"],
        }],
        omittedImpactCount: 0,
        limitations: [],
      },
    };

    const parsed = JSON.parse(renderJsonReport(withImpact));
    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.sourceImpact).toEqual(withImpact.sourceImpact);
  });

  it("preserves structured guidance and audit scope without custom serialization loss", () => {
    const scoped: ScanResult = {
      ...result(),
      auditScope: {
        mode: "changed",
        base: { kind: "merge-base", requestedRef: "main", resolvedCommit: "1234567890abcdef" },
        changes: [{ status: "renamed", path: "src/new.ts", previousPath: "src/old.ts" }],
        affectedProjectIds: ["root"],
        reasons: [{ projectId: "root", reason: "direct-change", source: "src/new.ts" }],
        limitations: ["Unchanged files were not independently re-audited."],
      },
    };

    const parsed = JSON.parse(renderJsonReport(scoped));
    expect(parsed.auditScope).toEqual(scoped.auditScope);
    expect(parsed.findings[0]).toMatchObject({
      impact: "A high-impact validation issue remains.",
      remediationConstraints: ["Preserve existing public behavior."],
      verification: {
        command: "codebase-doctor audit . --format json",
        expected: expect.stringContaining("coverage is completed"),
      },
    });
  });
});
