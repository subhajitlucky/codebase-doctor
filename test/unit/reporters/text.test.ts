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
    domainCoverage: [
      {
        domain: "repository",
        applicability: "detected",
        status: "completed",
        coverageComplete: true,
        evidence: [{ type: "module", value: "project" }],
        modules: [{ moduleId: "project", status: "completed", scopes: [], limitations: [] }],
        limitations: [],
      },
      {
        domain: "frontend",
        applicability: "detected",
        status: "unsupported",
        coverageComplete: false,
        evidence: [{ type: "framework", value: "react", projectId: "root" }],
        modules: [],
        limitations: ["Semantic frontend analysis is not implemented."],
      },
    ],
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

  it("renders domain applicability, status, completeness, modules, evidence, and limitations", () => {
    const report = renderTextReport(result());

    expect(report).toContain("Domain coverage");
    expect(report).toContain("repository: completed (applicability: detected; coverage complete: yes)");
    expect(report).toContain("Module: project — completed");
    expect(report).toContain("frontend: unsupported (applicability: detected; coverage complete: no)");
    expect(report).toContain("Evidence: framework react (project root)");
    expect(report).toContain("Limitation: Semantic frontend analysis is not implemented.");
    expect(report.indexOf("Domain coverage")).toBeLessThan(report.indexOf("Doctor runs"));
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

  it("does not call an incomplete domain audit clean when it has no findings", () => {
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

    expect(renderTextReport(empty)).toContain(
      "No findings, but domain coverage is incomplete; review Domain coverage before calling the codebase clean.",
    );
    expect(renderTextReport(empty)).not.toContain("Clean scan");
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
    expect(report).toContain(
      "No findings in the selected changed scope; review the selected scope, Doctor runs, and Audit coverage.",
    );
    expect(report).not.toContain("Clean scan");
    expect(report.indexOf("Audit scope")).toBeLessThan(report.indexOf("Projects"));
  });

  it("does not reference an Audit coverage section when changed scope has no module coverage", () => {
    const changed: ScanResult = {
      ...result(),
      auditScope: {
        mode: "changed",
        base: { kind: "head", requestedRef: null, resolvedCommit: "1234567890abcdef" },
        changes: [],
        affectedProjectIds: [],
        reasons: [],
        limitations: ["Only selected changes were audited."],
      },
      findings: [],
      summary: { total: 0, counts: { info: 0, low: 0, medium: 0, high: 0, critical: 0 }, highestSeverity: null },
    };

    const report = renderTextReport(changed);
    expect(report).toContain(
      "No findings in the selected changed scope; review the selected scope and Doctor runs.",
    );
    expect(report).not.toContain("Audit coverage");
  });

  it("caps changed paths and scope reasons deterministically without hiding limitations", () => {
    const changes = Array.from({ length: 23 }, (_, index) => ({
      status: "modified" as const,
      path: `src/${String(index + 1).padStart(2, "0")}.ts`,
    }));
    const reasons = Array.from({ length: 22 }, (_, index) => ({
      projectId: `project-${String(index + 1).padStart(2, "0")}`,
      reason: "direct-change" as const,
      source: `src/${String(index + 1).padStart(2, "0")}.ts`,
    }));
    const changed: ScanResult = {
      ...result(),
      auditScope: {
        mode: "changed",
        base: { kind: "head", requestedRef: null, resolvedCommit: "1234567890abcdef" },
        changes,
        affectedProjectIds: reasons.map(({ projectId }) => projectId),
        reasons,
        limitations: ["This limitation must remain visible."],
      },
    };

    const report = renderTextReport(changed);
    expect(renderTextReport(changed)).toBe(report);
    expect(report).toContain("modified: src/01.ts");
    expect(report).toContain("modified: src/20.ts");
    expect(report).not.toContain("modified: src/21.ts");
    expect(report).toContain("3 additional changed paths omitted.");
    expect(report).toContain("Scope reason: project-20 — direct-change from src/20.ts");
    expect(report).not.toContain("Scope reason: project-21");
    expect(report).toContain("2 additional scope reasons omitted.");
    expect(report).toContain("Scope limitation: This limitation must remain visible.");
    expect(report.indexOf("src/01.ts")).toBeLessThan(report.indexOf("src/20.ts"));
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
