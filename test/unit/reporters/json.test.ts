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
