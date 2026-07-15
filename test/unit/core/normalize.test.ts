import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { classifyScanExit, normalizeScanResult } from "../../../src/core/normalize.js";

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
  it("removes exact duplicates and deterministically sorts findings and doctor runs", () => {
    const high = finding("high", "z-rule");
    const info = finding("info", "a-rule");
    const first = normalizeScanResult("/repo", [], [
      run("z-doctor", { status: "completed", findings: [info], durationMs: 2 }),
      run("a-doctor", { status: "completed", findings: [high, high], durationMs: 1 }),
    ]);
    const second = normalizeScanResult("/repo", [], [
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
    const result = normalizeScanResult("/repo", [], [
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

  it("maps thresholds and operational failure to stable exit classifications", () => {
    const healthy = normalizeScanResult("/repo", [], [
      run("doctor", {
        status: "completed",
        findings: [finding("high", "failure")],
        durationMs: 1,
      }),
    ]);
    const operational = normalizeScanResult("/repo", [], [
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
});
