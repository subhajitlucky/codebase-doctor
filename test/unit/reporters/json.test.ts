import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../../src/core/normalize.js";
import { renderJsonReport } from "../../../src/reporters/json.js";

function result(): ScanResult {
  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: "0.1.0" },
    repository: { root: "/repo" },
    projects: [],
    doctorRuns: [{
      doctorId: "broken",
      status: "failed",
      durationMs: 3,
      findingCount: 0,
      error: { code: "doctor_execution_failed", message: "boom" },
      skipReason: null,
      checkRuns: [],
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
});
