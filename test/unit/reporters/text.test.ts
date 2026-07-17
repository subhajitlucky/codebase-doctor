import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../../src/core/normalize.js";
import { renderTextReport } from "../../../src/reporters/text.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function result(): ScanResult {
  return {
    schemaVersion: "1",
    tool: { name: "codebase-doctor", version: "0.1.0" },
    repository: { root: "/repo" },
    auditScope: fullAuditScope(),
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
      impact: "Dependency and project detection may be incomplete or incorrect.",
      remediationConstraints: ["Preserve the intended package metadata."],
      remediation: "Correct the JSON syntax.",
      verification: {
        command: "codebase-doctor audit . --format json",
        expected: "The fingerprint is absent and applicable audit coverage is completed.",
      },
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

  it("renders evidence and model guidance in stable order", () => {
    const report = renderTextReport(result());

    expect(report).toContain("[HIGH] Invalid package manifest");
    expect(report).toContain("package.json:1");
    expect(report).toContain("Evidence: manifest package.json — Unexpected token");
    expect(report).toContain("Impact: Dependency and project detection may be incomplete or incorrect.");
    expect(report).toContain("Repair constraint: Preserve the intended package metadata.");
    expect(report).toContain("Remediation: Correct the JSON syntax.");
    expect(report).toContain("Verification command: codebase-doctor audit . --format json");
    expect(report).toContain("Verification expected: The fingerprint is absent and applicable audit coverage is completed.");
    expect(report.indexOf("Evidence:")).toBeLessThan(report.indexOf("Impact:"));
    expect(report.indexOf("Impact:")).toBeLessThan(report.indexOf("Repair constraint:"));
    expect(report.indexOf("Repair constraint:")).toBeLessThan(report.indexOf("Remediation:"));
    expect(report.indexOf("Remediation:")).toBeLessThan(report.indexOf("Verification command:"));
  });

  it("renders database evidence without inventing a file location", () => {
    const { location: _location, ...baseFinding } = result().findings[0]!;
    const databaseResult: ScanResult = {
      ...result(),
      findings: [{
        ...baseFinding,
        ruleId: "database/rls/public-unconditional-write",
        doctorId: "database/rls",
        category: "database-security",
        title: "Anonymous-style role can write rows too broadly",
        message: "The policy predicate is unconditional.",
        evidence: [{
          type: "database",
          schema: "public",
          table: "documents",
          policy: "public write",
          detail: "The policy predicate is unconditional.",
        }],
      }],
    };

    const report = renderTextReport(databaseResult);

    expect(report).toContain("Evidence: database public.documents policy \"public write\"");
    expect(report).not.toContain("Location: postgres:");
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

  it("renders changed scope honestly and never calls it a global clean scan", () => {
    const changed: ScanResult = {
      ...result(),
      auditScope: {
        mode: "changed",
        base: { kind: "merge-base", requestedRef: "main", resolvedCommit: "1234567890abcdef" },
        changes: [
          { status: "renamed", path: "src/new.ts", previousPath: "src/old.ts" },
          { status: "modified", path: "package.json" },
        ],
        affectedProjectIds: ["root"],
        reasons: [{ projectId: "root", reason: "direct-change", source: "package.json" }],
        limitations: ["Unchanged files were not independently re-audited."],
      },
      findings: [],
      summary: { total: 0, counts: { info: 0, low: 0, medium: 0, high: 0, critical: 0 }, highestSeverity: null },
      coverage: [{ moduleId: "database/sql-rls", status: "skipped", scope: "changed", filesExamined: 0, statementsExamined: 0, statementsRecognized: 0, limitations: ["No changed SQL stream was selected."] }],
    };

    const report = renderTextReport(changed);
    expect(report).toContain("Audit scope: changed");
    expect(report).toContain("Base: merge-base; requested main; resolved 1234567890ab");
    expect(report).toContain("Changes: 2; affected projects: 1");
    expect(report).toContain("renamed: src/new.ts (previous: src/old.ts)");
    expect(report).toContain("Scope reason: root — direct-change from package.json");
    expect(report).toContain("Scope limitation: Unchanged files were not independently re-audited.");
    expect(report).toContain("No findings in the selected changed scope; review Audit coverage.");
    expect(report).not.toContain("Clean scan");
    expect(report.indexOf("Audit scope")).toBeLessThan(report.indexOf("Projects"));
  });

  it("renders partial audit coverage separately from findings", () => {
    const covered: ScanResult = {
      ...result(),
      coverage: [{
        moduleId: "database/sql-rls",
        status: "partial",
        scope: "root:supabase/migrations",
        filesExamined: 2,
        statementsExamined: 8,
        statementsRecognized: 7,
        limitations: ["Dynamic SQL was not evaluated."],
      }],
    };

    const report = renderTextReport(covered);

    expect(report).toContain("Audit coverage");
    expect(report).toContain("database/sql-rls: partial");
    expect(report).toContain("Dynamic SQL was not evaluated.");
  });
});
