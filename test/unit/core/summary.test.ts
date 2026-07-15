import { describe, expect, it } from "vitest";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { summarizeFindings } from "../../../src/core/summary.js";

function finding(severity: Severity, ruleId: string = severity): Finding {
  return {
    ruleId,
    doctorId: "project",
    severity,
    confidence: "high",
    category: "quality",
    title: `${severity} finding`,
    message: "Example diagnostic.",
    location: { path: "package.json" },
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({
      doctorId: "project",
      ruleId,
      location: { path: "package.json" },
      identity: ruleId,
    }),
  };
}

describe("finding summaries", () => {
  it("returns every severity count, total, and highest severity", () => {
    expect(summarizeFindings([
      finding("info", "one"),
      finding("medium", "two"),
      finding("medium", "three"),
      finding("critical", "four"),
    ])).toEqual({
      total: 4,
      counts: { info: 1, low: 0, medium: 2, high: 0, critical: 1 },
      highestSeverity: "critical",
    });
  });

  it("uses zero counts and no highest severity for an empty result", () => {
    expect(summarizeFindings([])).toEqual({
      total: 0,
      counts: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      highestSeverity: null,
    });
  });
});
