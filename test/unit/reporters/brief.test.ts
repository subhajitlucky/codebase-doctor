import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import type { DomainCoverage } from "../../../src/core/domain-coverage.js";
import { withBaselineComparison } from "../../../src/core/baseline.js";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { normalizeScanResult } from "../../../src/core/normalize.js";
import { renderBriefReport } from "../../../src/reporters/brief.js";
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
    remediation: `Fix ${ruleId} by following the documented guidance.`,
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
    domain: "performance",
    applicability: "detected",
    status: "unsupported",
    coverageComplete: false,
    evidence: [],
    modules: [],
    limitations: [],
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

describe("renderBriefReport", () => {
  it("emits one bounded line per finding with scope and coverage", () => {
    const report = renderBriefReport(
      scan([finding("high", "missing-tests"), finding("medium", "lockfile-conflict")]),
    );
    const lines = report.trimEnd().split("\n");

    expect(lines[0]).toBe("codebase-doctor brief");
    expect(lines[1]).toBe("scope=full findings=2 shown=2 coverage=complete");
    expect(report).toContain("[high] missing-tests src/index.ts — Fix missing-tests");
    expect(report).toContain("[medium] lockfile-conflict");
  });

  it("truncates findings beyond the budget and says so", () => {
    const report = renderBriefReport(
      scan([finding("high", "one"), finding("high", "two"), finding("high", "three")]),
      { maxFindings: 1 },
    );

    expect(report).toContain("shown=1");
    expect(report).toContain("truncated: 2 more finding(s)");
    expect(report).not.toContain("two");
  });

  it("lists coverage limitations instead of claiming completeness", () => {
    const report = renderBriefReport(scan([], partialCoverage));

    expect(report).toContain("coverage=incomplete");
    expect(report).toContain("coverage-limitations: performance: unsupported");
  });

  it("marks new and unchanged findings when a baseline comparison is present", () => {
    const existing = finding("high", "existing");
    const baseline = withBaselineComparison(scan([existing, finding("low", "fresh")]), [existing]);

    const report = renderBriefReport(baseline);

    expect(report).toContain("new=1 resolved=0");
    expect(report).toContain("= [high] existing");
    expect(report).toContain("+ [low] fresh");
  });
});
