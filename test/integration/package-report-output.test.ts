import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AUDIT_DOMAINS,
  auditCodebase,
  type AuditDomain,
  type AuditCoverage,
  type AuditBase,
  type AuditRequest,
  type AuditScope,
  type BaselineComparisonOptions,
  type ChangedPath,
  type ChangeStatus,
  type CoverageStatus,
  type DiscoveredChanges,
  type DiscoverChangesOptions,
  type DetectedProject,
  type DomainApplicability,
  type DomainCoverage,
  type DomainCoverageEvidence,
  type DomainCoverageStatus,
  type DomainModuleCoverage,
  type Evidence,
  discoverGitChanges,
  fullAuditScope,
  GitScopeError,
  type GitScopeErrorCode,
  type MissingTargetProof,
  planChangedScope,
  type ScopeReason,
  type SourceGraphEdge,
  type SourceGraphStatus,
  type SourceImpact,
} from "../../src/index.js";

const repositoryRoot = process.cwd();

describe("package report output", () => {
  it("exports the safe additive missing-target edge contract", () => {
    const proof: MissingTargetProof = "relative-explicit";
    const missing: SourceGraphEdge = {
      importerPath: "src/importer.ts",
      targetPath: "src/missing.ts",
      kind: "static",
      line: 1,
      column: 1,
      targetExists: false,
      missingTargetProof: proof,
    };
    const existing: SourceGraphEdge = {
      importerPath: "src/importer.ts",
      targetPath: "src/existing.ts",
      kind: "static",
      targetExists: true,
    };

    expect(missing.missingTargetProof).toBe("relative-explicit");
    expect(existing.targetExists).toBe(true);
    expectTypeOf(missing).toMatchTypeOf<SourceGraphEdge>();
  });

  it("exports unified audit and database evidence contracts", () => {
    const request: AuditRequest = {
      root: "/repo",
      runChecks: false,
      format: "json",
      timeoutMs: 1_000,
      failOn: "high",
      includeDatabaseAudit: true,
      includeSecurityAudit: true,
      withDatabase: false,
    };
    const evidence: Evidence = {
      type: "database",
      schema: "public",
      table: "documents",
      detail: "RLS is disabled.",
    };
    const status: CoverageStatus = "partial";
    const unsupportedStatus: CoverageStatus = "unsupported";
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
    expect(request.includeSecurityAudit).toBe(true);
    expect(evidence.type).toBe("database");
    expect(coverage.status).toBe("partial");
    expect(unsupportedStatus).toBe("unsupported");
  });

  it("exports the complete domain coverage contract", () => {
    const domain: AuditDomain = "security";
    const applicability: DomainApplicability = "unknown";
    const status: DomainCoverageStatus = "unsupported";
    const evidence: DomainCoverageEvidence = { type: "framework", value: "react" };
    const module: DomainModuleCoverage = {
      moduleId: "database/sql-rls",
      status: "completed",
      scopes: ["root:migrations"],
      limitations: [],
    };
    const coverage: DomainCoverage = {
      domain,
      applicability,
      status,
      coverageComplete: false,
      evidence: [evidence],
      modules: [module],
      limitations: ["General security analysis is not implemented."],
    };

    expect(AUDIT_DOMAINS).toHaveLength(9);
    expect(coverage).toMatchObject({
      domain: "security",
      applicability: "unknown",
      status: "unsupported",
      coverageComplete: false,
    });
  });

  it("exports the changed-audit and baseline comparison contracts", () => {
    const status: ChangeStatus = "renamed";
    const change: ChangedPath = {
      status,
      path: "packages/app/new.ts",
      previousPath: "packages/app/old.ts",
    };
    const base: AuditBase = {
      kind: "merge-base",
      requestedRef: "main",
      resolvedCommit: "0123456789abcdef",
    };
    const reason: ScopeReason = {
      projectId: "node:packages/app",
      reason: "source-dependent",
      source: change.path,
    };
    const graphStatus: SourceGraphStatus = "completed";
    const sourceImpact: SourceImpact = {
      mode: "changed",
      status: graphStatus,
      graphNodeCount: 2,
      graphEdgeCount: 1,
      externalBoundaryCount: 0,
      dynamicBoundaryCount: 0,
      changedSourcePaths: [change.path],
      impactedFileCount: 1,
      impactedProjectIds: [reason.projectId],
      impacts: [{
        path: "packages/app/consumer.ts",
        projectId: reason.projectId,
        dependencyPath: [change.path, "packages/app/consumer.ts"],
      }],
      omittedImpactCount: 0,
      limitations: [],
    };
    const scope: AuditScope = {
      mode: "changed",
      base,
      changes: [change],
      affectedProjectIds: [reason.projectId],
      reasons: [reason],
      limitations: [],
    };
    const discovered: DiscoveredChanges = { base, changes: [change] };
    const discoveryOptions: DiscoverChangesOptions = { root: "/repo", baseRef: "main" };
    const comparisonOptions: BaselineComparisonOptions = { includeResolved: false };
    const errorCode: GitScopeErrorCode = "GIT_INVALID_BASE_REF";
    const error: GitScopeError = new GitScopeError(errorCode, "invalid base");
    const project: DetectedProject = {
      id: "node:packages/app",
      root: "packages/app",
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: [],
      manifestPaths: ["packages/app/package.json"],
      executionSupport: "supported",
    };

    expect(typeof discoverGitChanges).toBe("function");
    expect(typeof planChangedScope).toBe("function");
    expect(fullAuditScope().mode).toBe("full");
    expect(scope.changes).toEqual(discovered.changes);
    expect(discoveryOptions.baseRef).toBe("main");
    expect(comparisonOptions.includeResolved).toBe(false);
    expect(error.code).toBe("GIT_INVALID_BASE_REF");
    expectTypeOf(discoverGitChanges).parameters.toEqualTypeOf<[DiscoverChangesOptions]>();
    expectTypeOf(planChangedScope).toBeCallableWith(base, [change], [project], sourceImpact);
    expect(project.id).toBe(reason.projectId);
    expect(sourceImpact.status).toBe("completed");
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
    expect(result.stdout).toContain("Verified codebase-doctor@0.1.5");
  });
});
