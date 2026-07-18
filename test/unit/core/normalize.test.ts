import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { classifyScanExit, normalizeScanResult } from "../../../src/core/normalize.js";
import { fullAuditScope } from "../../../src/scope/planner.js";
import type { AuditScope } from "../../../src/scope/types.js";
import type { DomainCoverage } from "../../../src/core/domain-coverage.js";
import type { SourceImpact } from "../../../src/source-graph/types.js";

function finding(severity: Severity, ruleId: string): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: ruleId,
    message: `${ruleId} message`,
    location: { path: `${ruleId}.ts` },
    evidence: [{ type: "observation", detail: ruleId }],
    remediation: `Fix ${ruleId}`,
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId,
      location: { path: `${ruleId}.ts` },
      identity: ruleId,
    }),
  };
}

function run(doctorId: string, result: DoctorResult): RegisteredDoctorResult {
  return { doctorId, result };
}

describe("scan normalization", () => {
  it("keeps source impact optional under schema version 1", () => {
    const withoutImpact = normalizeScanResult("/repo", [], fullAuditScope(), []);
    const impact: SourceImpact = {
      mode: "changed",
      status: "completed",
      graphNodeCount: 2,
      graphEdgeCount: 1,
      externalBoundaryCount: 0,
      dynamicBoundaryCount: 0,
      changedSourcePaths: ["src/z.ts", "src/a.ts"],
      impactedFileCount: 1,
      impactedProjectIds: ["z", "a"],
      impacts: [{
        path: "src/consumer.ts",
        projectId: "a",
        dependencyPath: ["src/z.ts", "src/consumer.ts"],
      }],
      omittedImpactCount: 0,
      limitations: ["z limitation", "a limitation"],
    };
    const withImpact = normalizeScanResult(
      "/repo",
      [],
      fullAuditScope(),
      [],
      [],
      [],
      impact,
    );

    expect(withoutImpact.schemaVersion).toBe("1");
    expect(withoutImpact).not.toHaveProperty("sourceImpact");
    expect(withImpact.schemaVersion).toBe("1");
    expect(withImpact.sourceImpact).toMatchObject({
      changedSourcePaths: ["src/a.ts", "src/z.ts"],
      impactedProjectIds: ["a", "z"],
      limitations: ["a limitation", "z limitation"],
    });
    expect(withImpact.sourceImpact).not.toBe(impact);
  });

  it("removes exact duplicates and deterministically sorts findings and doctor runs", () => {
    const high = finding("high", "z-rule");
    const info = finding("info", "a-rule");
    const first = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("z-doctor", { status: "completed", findings: [info], durationMs: 2 }),
      run("a-doctor", { status: "completed", findings: [high, high], durationMs: 1 }),
    ]);
    const second = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("a-doctor", { status: "completed", findings: [high], durationMs: 1 }),
      run("z-doctor", { status: "completed", findings: [info], durationMs: 2 }),
    ]);

    expect(first).toEqual(second);
    expect(first.findings.map(({ ruleId }) => ruleId)).toEqual(["z-rule", "a-rule"]);
    expect(first.doctorRuns.map(({ doctorId }) => doctorId)).toEqual(["a-doctor", "z-doctor"]);
    expect(first.summary).toEqual({
      total: 2,
      counts: { info: 1, low: 0, medium: 0, high: 1, critical: 0 },
      highestSeverity: "high",
    });
  });

  it("keeps operational failures separate from successful findings", () => {
    const result = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("broken", {
        status: "failed",
        findings: [],
        error: { code: "doctor_execution_failed", message: "boom" },
        durationMs: 4,
      }),
      run("healthy", {
        status: "completed",
        findings: [finding("medium", "useful-finding")],
        durationMs: 2,
      }),
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.doctorRuns[0]).toMatchObject({
      doctorId: "broken",
      status: "failed",
      error: { code: "doctor_execution_failed", message: "boom" },
    });
  });

  it("preserves and deterministically sorts audit coverage", () => {
    const result = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("database/sql-rls", {
        status: "completed",
        findings: [],
        durationMs: 1,
        coverage: [
          {
            moduleId: "database/sql-rls",
            status: "partial",
            scope: "root:supabase/migrations",
            filesExamined: 2,
            statementsExamined: 8,
            statementsRecognized: 7,
            limitations: ["Dynamic SQL was not evaluated."],
          },
          {
            moduleId: "database/sql-rls",
            status: "completed",
            scope: "root:drizzle",
            filesExamined: 1,
            statementsExamined: 3,
            statementsRecognized: 3,
            limitations: [],
          },
        ],
      }),
    ]);

    expect(result.coverage?.map(({ scope }) => scope)).toEqual([
      "root:drizzle",
      "root:supabase/migrations",
    ]);
  });

  it("copies and deterministically sorts audit scope without mutating the caller", () => {
    const scope: AuditScope = {
      mode: "changed",
      base: { kind: "merge-base", requestedRef: "main", resolvedCommit: "a".repeat(40) },
      changes: [
        { status: "modified", path: "z.ts" },
        { status: "added", path: "a.ts" },
      ],
      affectedProjectIds: ["z", "a"],
      reasons: [
        { projectId: "z", reason: "direct-change", source: "z.ts" },
        { projectId: "a", reason: "direct-change", source: "a.ts" },
      ],
      limitations: ["z limitation", "a limitation"],
    };

    const result = normalizeScanResult("/repo", [], scope, []);

    expect(result.auditScope).toEqual({
      ...scope,
      changes: [scope.changes[1], scope.changes[0]],
      affectedProjectIds: ["a", "z"],
      reasons: [scope.reasons[1], scope.reasons[0]],
      limitations: ["a limitation", "z limitation"],
    });
    expect(result.auditScope).not.toBe(scope);
    expect(result.auditScope.base).not.toBe(scope.base);
    expect(result.auditScope.changes[0]).not.toBe(scope.changes[1]);
    expect(scope.affectedProjectIds).toEqual(["z", "a"]);

    (scope.changes as Array<{ status: "modified"; path: string }>)[0]!.path = "mutated.ts";
    expect(result.auditScope.changes.map(({ path }) => path)).toEqual(["a.ts", "z.ts"]);
  });

  it("copies and deterministically normalizes domain coverage", () => {
    const domainCoverage: DomainCoverage[] = [
      {
        domain: "security",
        applicability: "unknown",
        status: "unsupported",
        coverageComplete: false,
        evidence: [],
        modules: [],
        limitations: ["z limitation", "a limitation", "a limitation"],
      },
      {
        domain: "repository",
        applicability: "detected",
        status: "completed",
        coverageComplete: true,
        evidence: [
          { type: "module", value: "z" },
          { type: "module", value: "a" },
        ],
        modules: [{
          moduleId: "project",
          status: "completed",
          scopes: ["z", "a", "a"],
          limitations: ["z", "a", "a"],
        }],
        limitations: [],
      },
    ];

    const result = normalizeScanResult(
      "/repo",
      [],
      fullAuditScope(),
      [],
      [],
      domainCoverage,
    );

    expect(result.domainCoverage.map(({ domain }) => domain)).toEqual([
      "repository",
      "security",
    ]);
    expect(result.domainCoverage[0]).toMatchObject({
      evidence: [
        { type: "module", value: "a" },
        { type: "module", value: "z" },
      ],
      modules: [{ scopes: ["a", "z"], limitations: ["a", "z"] }],
    });
    expect(result.domainCoverage[1]?.limitations).toEqual(["a limitation", "z limitation"]);

    (domainCoverage[0]!.limitations as string[])[0] = "mutated";
    (domainCoverage[1]!.modules[0]!.scopes as string[])[0] = "mutated";
    expect(result.domainCoverage[1]?.limitations).toEqual(["a limitation", "z limitation"]);
    expect(result.domainCoverage[0]?.modules[0]?.scopes).toEqual(["a", "z"]);
  });

  it("maps thresholds and operational failure to stable exit classifications", () => {
    const healthy = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("doctor", {
        status: "completed",
        findings: [finding("high", "failure")],
        durationMs: 1,
      }),
    ]);
    const operational = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("doctor", {
        status: "failed",
        findings: [],
        error: { code: "failed", message: "failed" },
        durationMs: 1,
      }),
    ]);

    expect(classifyScanExit(healthy, "medium")).toBe(1);
    expect(classifyScanExit(healthy, "high")).toBe(1);
    expect(classifyScanExit(healthy, "critical")).toBe(0);
    expect(classifyScanExit(healthy, "none")).toBe(0);
    expect(classifyScanExit(operational, "none")).toBe(2);
  });

  it("treats a high source-integrity finding as a finding exit, never an operational error", () => {
    const missingTarget = {
      ...finding("high", "source/import-target-missing"),
      doctorId: "repository/source-integrity",
      category: "correctness",
      title: "Internal import target is missing",
    } satisfies Finding;
    const result = normalizeScanResult("/repo", [], fullAuditScope(), [
      run("repository/source-integrity", {
        status: "completed",
        findings: [missingTarget],
        durationMs: 0,
      }),
    ]);

    expect(result.schemaVersion).toBe("1");
    expect(result.doctorRuns[0]).toMatchObject({ status: "completed", error: null });
    expect(classifyScanExit(result, "high")).toBe(1);
    expect(classifyScanExit(result, "none")).toBe(0);
  });
});
