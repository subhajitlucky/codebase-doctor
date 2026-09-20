import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import type { DomainCoverage } from "../../../src/core/domain-coverage.js";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { normalizeScanResult } from "../../../src/core/normalize.js";
import { classifyVerifyExit, verifyRepairs } from "../../../src/core/verify.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function finding(severity: Severity, ruleId: string, path = "src/index.ts"): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: `${ruleId} title`,
    message: `${ruleId} message`,
    location: { path },
    evidence: [{ type: "observation", detail: ruleId }],
    remediation: `Fix ${ruleId}`,
    verification: { command: "npm test", expected: "green" },
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId,
      location: { path },
      identity: ruleId,
    }),
  };
}

function run(doctorId: string, result: DoctorResult): RegisteredDoctorResult {
  return { doctorId, result };
}

const partialCoverage: DomainCoverage[] = [
  {
    domain: "frontend",
    applicability: "detected",
    status: "partial",
    coverageComplete: false,
    evidence: [],
    modules: [],
    limitations: ["frontend analysis is not implemented"],
  },
];

function scan(findings: Finding[], domainCoverage: DomainCoverage[] = []) {
  return normalizeScanResult(
    "/repo",
    [],
    fullAuditScope(),
    [run("fixture", { status: "completed", findings, durationMs: 0 })],
    [],
    domainCoverage,
  );
}

describe("verifyRepairs", () => {
  it("resolves absent baseline findings only under complete coverage", () => {
    const baseline = [finding("high", "rls-disabled")];
    const verification = verifyRepairs(baseline, scan([]));

    expect(verification.coverageComplete).toBe(true);
    expect(verification.counts).toEqual({
      resolved: 1,
      unchanged: 0,
      unresolved: 0,
      new: 0,
    });
    expect(verification.baseline[0]).toMatchObject({
      status: "resolved",
      severity: "high",
      ruleId: "rls-disabled",
      remediation: "Fix rls-disabled",
    });
    expect(classifyVerifyExit(verification, "high")).toBe(0);
  });

  it("keeps absent findings unresolved under incomplete coverage", () => {
    const baseline = [finding("high", "rls-disabled")];
    const verification = verifyRepairs(baseline, scan([], partialCoverage));

    expect(verification.coverageComplete).toBe(false);
    expect(verification.counts.unresolved).toBe(1);
    expect(verification.coverageLimitations).toContain("frontend: partial");
    expect(verification.baseline[0]).toMatchObject({ status: "unresolved" });
    expect(classifyVerifyExit(verification, "high")).toBe(1);
  });

  it("reports present baseline findings as unchanged and fails by default", () => {
    const baseline = [finding("medium", "rls-disabled")];
    const verification = verifyRepairs(baseline, scan([finding("medium", "rls-disabled")]));

    expect(verification.counts.unchanged).toBe(1);
    expect(classifyVerifyExit(verification, "high")).toBe(1);
    expect(classifyVerifyExit(verification, "high", { allowUnchanged: true })).toBe(0);
  });

  it("counts new findings and applies the failure threshold", () => {
    const highNew = scan([finding("high", "new-high")]);
    const highVerification = verifyRepairs([], highNew);
    expect(highVerification.counts.new).toBe(1);
    expect(highVerification.newFindings[0]).toMatchObject({ status: "new", ruleId: "new-high" });
    expect(classifyVerifyExit(highVerification, "high")).toBe(1);
    expect(classifyVerifyExit(highVerification, "none")).toBe(0);

    const lowVerification = verifyRepairs([], scan([finding("low", "new-low")]));
    expect(classifyVerifyExit(lowVerification, "high")).toBe(0);
  });

  it("sorts baseline entries by severity, path, and rule id", () => {
    const baseline = [
      finding("low", "b-rule", "src/z.ts"),
      finding("high", "c-rule", "src/a.ts"),
      finding("high", "a-rule", "src/a.ts"),
    ];
    const verification = verifyRepairs(baseline, scan([]));

    expect(verification.baseline.map((entry) => entry.ruleId)).toEqual([
      "a-rule",
      "c-rule",
      "b-rule",
    ]);
  });
});
