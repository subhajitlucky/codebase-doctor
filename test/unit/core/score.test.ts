import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import type { DomainCoverage } from "../../../src/core/domain-coverage.js";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { normalizeScanResult, type DoctorRunRecord } from "../../../src/core/normalize.js";
import { bandForScore, scoreReport, scoreScanResult } from "../../../src/core/score.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function finding(severity: Severity): { severity: Severity } {
  return { severity };
}

function coverage(overrides: Partial<DomainCoverage> = {}): DomainCoverage {
  return {
    domain: "security",
    applicability: "detected",
    status: "completed",
    coverageComplete: true,
    evidence: [],
    modules: [],
    limitations: [],
    ...overrides,
  };
}

function run(status: DoctorRunRecord["status"] = "completed"): DoctorRunRecord {
  return {
    doctorId: "fixture",
    status,
    durationMs: 0,
    findingCount: 0,
    error: null,
    skipReason: null,
    checkRuns: [],
  };
}

describe("scoreReport", () => {
  it("scores a clean, fully covered audit at 100 green", () => {
    expect(scoreReport([], [coverage()], [run()])).toEqual({
      value: 100,
      band: "green",
      findingPenalty: 0,
      coveragePenalty: 0,
    });
  });

  it("applies deterministic severity penalties", () => {
    const score = scoreReport(
      [finding("critical"), finding("high"), finding("medium"), finding("low"), finding("info")],
      [coverage()],
      [run()],
    );
    expect(score.findingPenalty).toBe(40);
    expect(score.value).toBe(60);
    expect(score.band).toBe("yellow");
  });

  it("penalizes incomplete coverage and failed doctor runs by 10", () => {
    expect(scoreReport([], [coverage({ coverageComplete: false })], [run()]).coveragePenalty).toBe(10);
    expect(scoreReport([], [coverage()], [run("failed")]).coveragePenalty).toBe(10);
    expect(scoreReport([], [coverage()], [run("skipped")]).coveragePenalty).toBe(0);
  });

  it("clamps at zero and never goes negative", () => {
    const score = scoreReport(
      [finding("critical"), finding("critical"), finding("critical"), finding("critical")],
      [coverage({ coverageComplete: false })],
      [run("failed")],
    );
    expect(score.value).toBe(0);
    expect(score.band).toBe("red");
  });

  it("maps score bands at the documented boundaries", () => {
    expect(bandForScore(100)).toBe("green");
    expect(bandForScore(80)).toBe("green");
    expect(bandForScore(79)).toBe("yellow");
    expect(bandForScore(50)).toBe("yellow");
    expect(bandForScore(49)).toBe("red");
    expect(bandForScore(0)).toBe("red");
  });

  it("matches the score stored on a normalized scan result", () => {
    const registered: RegisteredDoctorResult = {
      doctorId: "fixture",
      result: {
        status: "completed",
        durationMs: 0,
        findings: [resultFinding("high"), resultFinding("medium")],
      } satisfies DoctorResult,
    };
    const result = normalizeScanResult(
      "/repo",
      [],
      fullAuditScope(),
      [registered],
      [],
      [coverage()],
    );

    expect(result.score).toEqual({
      value: 86,
      band: "green",
      findingPenalty: 14,
      coveragePenalty: 0,
    });
    expect(scoreScanResult(result)).toEqual(result.score);
  });
});

function resultFinding(severity: Severity): Finding {
  return {
    ruleId: `rule-${severity}`,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: `${severity} title`,
    message: `${severity} message`,
    evidence: [{ type: "observation", detail: severity }],
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId: `rule-${severity}`,
      identity: severity,
    }),
  };
}
