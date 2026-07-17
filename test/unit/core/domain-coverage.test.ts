import { describe, expect, it } from "vitest";
import {
  AUDIT_DOMAINS,
  planDomainCoverage,
  type AuditDomain,
  type DomainApplicability,
  type DomainCoverage,
  type DomainCoverageStatus,
} from "../../../src/core/domain-coverage.js";
import type { RegisteredDoctorResult } from "../../../src/core/doctor.js";
import type { CommandPlan } from "../../../src/execution/types.js";
import { fullAuditScope } from "../../../src/scope/planner.js";
import type { AuditScope } from "../../../src/scope/types.js";
import type { ProjectSnapshot } from "../../../src/workspace/types.js";

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/repo",
    files: [],
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
    ...overrides,
  };
}

function result(
  doctorId: string,
  status: "completed" | "skipped" | "failed" = "completed",
): RegisteredDoctorResult {
  return {
    doctorId,
    result: {
      status,
      findings: [],
      durationMs: 1,
      ...(status === "skipped" ? { skipReason: "Permission was not granted." } : {}),
      ...(status === "failed"
        ? { error: { code: "fixture_failed", message: "Fixture failure." } }
        : {}),
    },
  };
}

function changedScope(
  affectedProjectIds: readonly string[],
  changes: AuditScope["changes"] = [],
): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes,
    affectedProjectIds,
    reasons: [],
    limitations: [],
  };
}

describe("domain coverage planning", () => {
  it("defines the complete domain checklist in stable order", () => {
    const domains: readonly AuditDomain[] = AUDIT_DOMAINS;
    const applicability: DomainApplicability = "unknown";
    const status: DomainCoverageStatus = "unsupported";
    const entry: DomainCoverage = {
      domain: "security",
      applicability,
      status,
      coverageComplete: false,
      evidence: [],
      modules: [],
      limitations: ["General security analysis is not implemented."],
    };

    expect(domains).toEqual([
      "repository",
      "validation",
      "frontend",
      "backend",
      "database",
      "security",
      "infrastructure",
      "performance",
      "ai",
    ]);
    expect(entry).toMatchObject({
      domain: "security",
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
    });
  });

  it("derives conservative applicability from existing repository evidence", () => {
    const project: ProjectSnapshot["projects"][number] = {
      id: "root",
      root: ".",
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: ["vite", "react", "nestjs", "nextjs"],
      dependencyNames: ["zod", "openai", "@anthropic-ai/sdk"],
      manifestPaths: ["package.json"],
      executionSupport: "supported",
    };
    const plans: CommandPlan[] = [{
      id: "root:test",
      projectId: "root",
      label: "test",
      executable: "npm",
      args: ["run", "test"],
      cwd: "/repo",
      timeoutMs: 1_000,
    }];
    const coverage = planDomainCoverage({
      snapshot: snapshot({
        projects: [project],
        files: [
          { path: ".github/workflows/ci.yml", kind: "file", size: 1 },
          { path: "Dockerfile", kind: "file", size: 1 },
          { path: "vercel.json", kind: "file", size: 1 },
        ],
      }),
      registeredResults: [result("project"), result("checks", "skipped")],
      plans,
      includeDatabaseAudit: false,
    });

    expect(coverage.map(({ domain }) => domain)).toEqual(AUDIT_DOMAINS);
    expect(coverage.find(({ domain }) => domain === "frontend")).toMatchObject({
      applicability: "detected",
      status: "unsupported",
      coverageComplete: false,
      evidence: [
        { type: "framework", value: "nextjs", projectId: "root" },
        { type: "framework", value: "react", projectId: "root" },
        { type: "framework", value: "vite", projectId: "root" },
      ],
    });
    expect(coverage.find(({ domain }) => domain === "backend")).toMatchObject({
      applicability: "detected",
      status: "unsupported",
      evidence: [{ type: "framework", value: "nestjs", projectId: "root" }],
    });
    expect(coverage.find(({ domain }) => domain === "infrastructure")).toMatchObject({
      applicability: "detected",
      status: "unsupported",
      evidence: [
        { type: "file", value: "github-actions", path: ".github/workflows/ci.yml" },
        { type: "file", value: "docker", path: "Dockerfile" },
        { type: "file", value: "vercel", path: "vercel.json" },
      ],
    });
    expect(coverage.find(({ domain }) => domain === "ai")).toMatchObject({
      applicability: "detected",
      status: "unsupported",
      evidence: [
        { type: "dependency", value: "@anthropic-ai/sdk", projectId: "root" },
        { type: "dependency", value: "openai", projectId: "root" },
      ],
    });
    expect(coverage.find(({ domain }) => domain === "security")).toMatchObject({
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
    });
    expect(coverage.find(({ domain }) => domain === "performance")).toMatchObject({
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
    });
  });

  it("preserves module detail and aggregates mixed database coverage as partial", () => {
    const registeredResults: RegisteredDoctorResult[] = [
      result("project"),
      {
        doctorId: "database/sql-rls",
        result: {
          status: "completed",
          findings: [],
          durationMs: 2,
          coverage: [{
            moduleId: "database/sql-rls",
            status: "completed",
            scope: "root:supabase/migrations",
            filesExamined: 2,
            statementsExamined: 8,
            statementsRecognized: 8,
            limitations: [],
          }],
        },
      },
      result("database/rls", "skipped"),
    ];

    const coverage = planDomainCoverage({
      snapshot: snapshot(),
      registeredResults,
      plans: [],
      includeDatabaseAudit: true,
    });
    const database = coverage.find(({ domain }) => domain === "database");

    expect(database).toMatchObject({
      applicability: "detected",
      status: "partial",
      coverageComplete: false,
      modules: [
        {
          moduleId: "database/rls",
          status: "skipped",
          scopes: [],
          limitations: ["Permission was not granted."],
        },
        {
          moduleId: "database/sql-rls",
          status: "completed",
          scopes: ["root:supabase/migrations"],
          limitations: [],
        },
      ],
    });
  });

  it("makes failed and partial module evidence incomplete", () => {
    const registeredResults: RegisteredDoctorResult[] = [
      result("project", "failed"),
      {
        doctorId: "database/sql-rls",
        result: {
          status: "completed",
          findings: [],
          durationMs: 2,
          coverage: [{
            moduleId: "database/sql-rls",
            status: "partial",
            scope: "root:migrations",
            filesExamined: 1,
            statementsExamined: 2,
            statementsRecognized: 1,
            limitations: ["Dynamic SQL was not evaluated."],
          }],
        },
      },
    ];

    const coverage = planDomainCoverage({
      snapshot: snapshot(),
      registeredResults,
      plans: [],
      includeDatabaseAudit: true,
    });

    expect(coverage.find(({ domain }) => domain === "repository")).toMatchObject({
      status: "failed",
      coverageComplete: false,
      limitations: ["Fixture failure."],
    });
    expect(coverage.find(({ domain }) => domain === "database")).toMatchObject({
      status: "partial",
      coverageComplete: false,
      limitations: ["Dynamic SQL was not evaluated."],
    });
  });

  it("maps completed Secrets Doctor coverage into the security domain", () => {
    const coverage = planDomainCoverage({
      snapshot: snapshot(),
      registeredResults: [result("project"), {
        doctorId: "security/secrets",
        result: {
          status: "completed",
          findings: [],
          durationMs: 1,
          coverage: [{
            moduleId: "security/secrets",
            status: "completed",
            scope: "full",
            filesExamined: 4,
            statementsExamined: 20,
            statementsRecognized: 0,
            limitations: [],
          }],
        },
      }],
      plans: [],
      includeDatabaseAudit: false,
    });

    expect(coverage.find(({ domain }) => domain === "security")).toEqual({
      domain: "security",
      applicability: "detected",
      status: "completed",
      coverageComplete: true,
      evidence: [{ type: "module", value: "security/secrets" }],
      modules: [{
        moduleId: "security/secrets",
        status: "completed",
        scopes: ["full"],
        limitations: [],
      }],
      limitations: [],
    });
  });

  it.each([
    ["partial", "partial", "detected", false],
    ["failed", "failed", "detected", false],
    ["not-applicable", "not-applicable", "not-detected", true],
  ] as const)(
    "maps %s Secrets Doctor coverage conservatively",
    (moduleStatus, status, applicability, coverageComplete) => {
      const registered = moduleStatus === "failed"
        ? result("security/secrets", "failed")
        : {
            doctorId: "security/secrets",
            result: {
              status: "completed" as const,
              findings: [],
              durationMs: 1,
              coverage: [{
                moduleId: "security/secrets",
                status: moduleStatus,
                scope: "full",
                filesExamined: 0,
                statementsExamined: 0,
                statementsRecognized: 0,
                limitations: moduleStatus === "partial" ? ["Budget reached."] : [],
              }],
            },
          };
      const coverage = planDomainCoverage({
        snapshot: snapshot(),
        registeredResults: [result("project"), registered],
        plans: [],
        includeDatabaseAudit: false,
      });

      expect(coverage.find(({ domain }) => domain === "security")).toMatchObject({
        applicability,
        status,
        coverageComplete,
        evidence: [{ type: "module", value: "security/secrets" }],
      });
    },
  );

  it("marks an empty changed Secrets Doctor selection as not selected", () => {
    const coverage = planDomainCoverage({
      snapshot: snapshot({ auditScope: changedScope([]) }),
      registeredResults: [result("project"), {
        doctorId: "security/secrets",
        result: {
          status: "completed",
          findings: [],
          durationMs: 1,
          coverage: [{
            moduleId: "security/secrets",
            status: "not-applicable",
            scope: "changed",
            filesExamined: 0,
            statementsExamined: 0,
            statementsRecognized: 0,
            limitations: [],
          }],
        },
      }],
      plans: [],
      includeDatabaseAudit: false,
    });

    expect(coverage.find(({ domain }) => domain === "security")).toMatchObject({
      applicability: "unknown",
      status: "not-selected",
      coverageComplete: false,
      modules: [{ moduleId: "security/secrets", status: "not-applicable" }],
      limitations: ["No current changed file was selected for secrets analysis."],
    });
  });

  it("marks detected domains outside an empty changed scope as not selected", () => {
    const project: ProjectSnapshot["projects"][number] = {
      id: "root",
      root: ".",
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: ["react"],
      manifestPaths: ["package.json"],
      executionSupport: "supported",
    };
    const coverage = planDomainCoverage({
      snapshot: snapshot({
        projects: [project],
        auditScope: changedScope([]),
      }),
      registeredResults: [result("project")],
      plans: [],
      includeDatabaseAudit: true,
    });

    expect(coverage.find(({ domain }) => domain === "repository")).toMatchObject({
      status: "completed",
      coverageComplete: true,
    });
    expect(coverage.find(({ domain }) => domain === "frontend")).toMatchObject({
      applicability: "detected",
      status: "not-selected",
      coverageComplete: false,
    });
    expect(coverage.find(({ domain }) => domain === "security")).toMatchObject({
      applicability: "unknown",
      status: "not-selected",
      coverageComplete: false,
    });
  });

  it("keeps detected evidence in an affected changed project actionable", () => {
    const project: ProjectSnapshot["projects"][number] = {
      id: "web",
      root: "apps/web",
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: ["nextjs", "react"],
      manifestPaths: ["apps/web/package.json"],
      executionSupport: "supported",
    };
    const coverage = planDomainCoverage({
      snapshot: snapshot({
        projects: [project],
        auditScope: changedScope(["web"], [
          { status: "modified", path: "apps/web/src/page.tsx" },
        ]),
      }),
      registeredResults: [result("project")],
      plans: [],
      includeDatabaseAudit: true,
    });

    expect(coverage.find(({ domain }) => domain === "frontend")).toMatchObject({
      applicability: "detected",
      status: "unsupported",
      coverageComplete: false,
    });
  });

  it("marks database modules as not selected by the repository-only scan", () => {
    const coverage = planDomainCoverage({
      snapshot: snapshot(),
      registeredResults: [result("project")],
      plans: [],
      includeDatabaseAudit: false,
    });

    expect(coverage.find(({ domain }) => domain === "database")).toMatchObject({
      applicability: "unknown",
      status: "not-selected",
      coverageComplete: false,
      limitations: ["The repository-only scan command does not select database audit modules."],
    });
  });
});
