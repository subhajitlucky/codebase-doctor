import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../../src/core/normalize.js";
import { renderSarifReport } from "../../../src/reporters/sarif.js";

function result(): ScanResult {
  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: "0.1.1" },
    repository: { root: "/repo" },
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
      location: { path: "package.json", line: 2, column: 4 },
      evidence: [{ type: "manifest", path: "package.json", detail: "Unexpected token" }],
      remediation: "Correct the JSON syntax.",
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
        artifactLocation: { uri: "package.json" },
        region: { startLine: 2, startColumn: 4 },
      } }],
      properties: { category: "repository", confidence: "high" },
    });
  });
});
