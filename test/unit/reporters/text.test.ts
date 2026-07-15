import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../../src/core/normalize.js";
import { renderTextReport } from "../../../src/reporters/text.js";

function result(): ScanResult {
  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: "0.1.0" },
    repository: { root: "/repo" },
    projects: [{
      id: "root",
      root: ".",
      ecosystems: ["node"],
      languages: ["javascript", "typescript"],
      frameworks: ["react"],
      packageManager: "npm",
      manifestPaths: ["package.json"],
      executionSupport: "supported",
    }],
    plannedChecks: [{
      planId: "root:javascript:test",
      projectId: "root",
      label: "JavaScript test",
      command: "npm run test",
    }],
    doctorRuns: [
      {
        doctorId: "checks",
        status: "skipped",
        durationMs: 0,
        findingCount: 0,
        error: null,
        skipReason: "Doctor requires denied capabilities: process:execute.",
        checkRuns: [],
      },
      {
        doctorId: "project",
        status: "completed",
        durationMs: 2,
        findingCount: 1,
        error: null,
        skipReason: null,
        checkRuns: [],
      },
    ],
    findings: [{
      ruleId: "repository/invalid-manifest",
      doctorId: "project",
      severity: "high",
      confidence: "high",
      category: "repository",
      title: "Invalid package manifest",
      message: "package.json could not be parsed.",
      location: { path: "package.json", line: 1 },
      evidence: [{ type: "manifest", path: "package.json", detail: "Unexpected token" }],
      remediation: "Correct the JSON syntax.",
      fingerprint: "fingerprint",
    }],
    summary: {
      total: 1,
      counts: { info: 0, low: 0, medium: 0, high: 1, critical: 0 },
      highestSeverity: "high",
    },
  };
}

describe("text reporter", () => {
  it("shows projects, execution support, and doctor status", () => {
    const report = renderTextReport(result());

    expect(report).toContain("Project: .");
    expect(report).toContain("Ecosystems: node");
    expect(report).toContain("Check support: supported");
    expect(report).toContain("checks: skipped");
    expect(report).toContain("process:execute");
    expect(report).toContain("Planned checks");
    expect(report).toContain("npm run test");
  });

  it("renders severity, evidence, and remediation readably", () => {
    const report = renderTextReport(result());

    expect(report).toContain("[HIGH] Invalid package manifest");
    expect(report).toContain("package.json:1");
    expect(report).toContain("Evidence: manifest package.json — Unexpected token");
    expect(report).toContain("Remediation: Correct the JSON syntax.");
  });

  it("does not emit ANSI in NO_COLOR or non-TTY mode", () => {
    const noColor = renderTextReport(result(), { color: true, isTTY: true, noColor: true });
    const nonTty = renderTextReport(result(), { color: true, isTTY: false, noColor: false });

    expect(noColor).not.toMatch(/\u001b\[/);
    expect(nonTty).not.toMatch(/\u001b\[/);
  });

  it("prints an explicit clean summary for an empty scan", () => {
    const empty: ScanResult = {
      ...result(),
      projects: [],
      doctorRuns: [],
      findings: [],
      summary: {
        total: 0,
        counts: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
        highestSeverity: null,
      },
    };

    expect(renderTextReport(empty)).toContain("Clean scan: no findings.");
  });
});
