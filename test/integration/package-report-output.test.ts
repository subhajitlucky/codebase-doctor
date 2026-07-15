import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditCodebase,
  type AuditCoverage,
  type AuditRequest,
  type CoverageStatus,
  type Evidence,
} from "../../src/index.js";

const repositoryRoot = process.cwd();

describe("package report output", () => {
  it("exports unified audit and database evidence contracts", () => {
    const request: AuditRequest = {
      root: "/repo",
      runChecks: false,
      format: "json",
      timeoutMs: 1_000,
      failOn: "high",
      includeDatabaseAudit: true,
      withDatabase: false,
    };
    const evidence: Evidence = {
      type: "database",
      schema: "public",
      table: "documents",
      detail: "RLS is disabled.",
    };
    const status: CoverageStatus = "partial";
    const coverage: AuditCoverage = {
      moduleId: "database/sql-rls",
      status,
      scope: "root:supabase/migrations",
      filesExamined: 1,
      statementsExamined: 2,
      statementsRecognized: 1,
      limitations: ["Dynamic SQL was not evaluated."],
    };

    expect(typeof auditCodebase).toBe("function");
    expect(request.includeDatabaseAudit).toBe(true);
    expect(evidence.type).toBe("database");
    expect(coverage.status).toBe("partial");
  });

  it("accepts lifecycle output before npm pack JSON", () => {
    const fakeNpmDirectory = join(repositoryRoot, "test", "fixtures", "noisy-npm");
    const result = spawnSync(process.execPath, ["scripts/check-package.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeNpmDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Verified codebase-doctor@0.1.2");
  });
});
