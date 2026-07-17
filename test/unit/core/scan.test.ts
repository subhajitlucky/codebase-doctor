import { describe, expect, it, vi } from "vitest";
import type { Doctor, DoctorContext, DoctorResult } from "../../../src/core/doctor.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import { scanCodebase, type ScanDependencies, type ScanRequest } from "../../../src/core/scan.js";
import type { FileInventory, ProjectDetection } from "../../../src/workspace/types.js";

const inventory: FileInventory = { root: "/repo", files: [] };
const detection: ProjectDetection = {
  projects: [{
    id: "root",
    root: ".",
    ecosystems: ["node"],
    languages: ["javascript"],
    frameworks: [],
    packageManager: "npm",
    manifestPaths: ["package.json"],
    executionSupport: "supported",
  }],
  workspaces: [],
};

function finding(): Finding {
  return {
    ruleId: "fixture/finding",
    doctorId: "project",
    severity: "medium",
    confidence: "high",
    category: "fixture",
    title: "Fixture finding",
    message: "Fixture message",
    evidence: [{ type: "observation", detail: "fixture" }],
    fingerprint: createFingerprint({
      doctorId: "project",
      ruleId: "fixture/finding",
      identity: "fixture",
    }),
  };
}

function doctor(
  id: string,
  capabilities: Doctor["capabilities"],
  diagnose: Doctor["diagnose"],
): Doctor {
  return {
    id,
    version: "0.1.0",
    capabilities,
    supports: () => true,
    diagnose,
  };
}

function request(
  runChecks: boolean,
  overrides: Partial<ScanRequest> = {},
): ScanRequest {
  return {
    root: "/repo",
    runChecks,
    format: "json",
    timeoutMs: 1_000,
    failOn: "high",
    ...overrides,
  };
}

function dependencies(doctors: readonly Doctor[]): ScanDependencies {
  return {
    inventoryWorkspace: vi.fn(async () => inventory),
    loadManifests: vi.fn(async () => []),
    detectWorkspaceProjects: vi.fn(async () => detection),
    discoverRepositoryFiles: vi.fn(async () => ({
      availability: "available" as const,
      paths: ["package.json"],
      limitations: [],
    })),
    discoverChanges: vi.fn(async () => ({
      base: { kind: "head" as const, requestedRef: null, resolvedCommit: "a".repeat(40) },
      changes: [],
    })),
    createDoctors: () => doctors,
  };
}

describe("scan orchestration", () => {
  it("builds one inventory and always runs the read-only Project Doctor", async () => {
    const diagnose = vi.fn(async () => ({
      status: "completed" as const,
      findings: [finding()],
      durationMs: 1,
    }));
    const deps = dependencies([doctor("project", ["filesystem:read"], diagnose)]);

    const result = await scanCodebase(request(false), deps);

    expect(deps.inventoryWorkspace).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(result.findings).toHaveLength(1);
    expect(result.auditScope).toEqual({
      mode: "full",
      base: null,
      changes: [],
      affectedProjectIds: [],
      reasons: [],
      limitations: [],
    });
    expect(result.domainCoverage).toHaveLength(9);
    expect(result.domainCoverage.map(({ domain }) => domain)).toEqual([
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
  });

  it("discovers repository-shareable files once for a full combined audit", async () => {
    const contexts: DoctorContext[] = [];
    const auditDoctor = doctor("project", ["filesystem:read"], async (context) => {
      contexts.push(context);
      return { status: "completed", findings: [], durationMs: 1 };
    });
    const deps = dependencies([auditDoctor]);

    await scanCodebase(request(false, { includeSecurityAudit: true }), deps);

    expect(deps.discoverRepositoryFiles).toHaveBeenCalledOnce();
    expect(deps.discoverRepositoryFiles).toHaveBeenCalledWith("/repo");
    expect(contexts[0]?.snapshot.repositoryFiles).toEqual({
      availability: "available",
      paths: ["package.json"],
      limitations: [],
    });
  });

  it("does not run full repository-file discovery for changed audit or scan", async () => {
    const changed = dependencies([]);
    await scanCodebase(request(false, {
      includeSecurityAudit: true,
      changed: true,
    }), changed);

    const scanned = dependencies([]);
    await scanCodebase(request(false), scanned);

    expect(changed.discoverRepositoryFiles).not.toHaveBeenCalled();
    expect(scanned.discoverRepositoryFiles).not.toHaveBeenCalled();
  });

  it("does not couple repository-file discovery to the database audit flag", async () => {
    const deps = dependencies([]);

    await scanCodebase(request(false, { includeDatabaseAudit: true }), deps);

    expect(deps.discoverRepositoryFiles).not.toHaveBeenCalled();
  });

  it("discovers changed scope once after project detection and exposes it to every doctor", async () => {
    const events: string[] = [];
    const changed = dependencies([]);
    changed.inventoryWorkspace = vi.fn(async () => {
      events.push("inventory");
      return inventory;
    });
    changed.loadManifests = vi.fn(async () => {
      events.push("manifests");
      return [];
    });
    changed.detectWorkspaceProjects = vi.fn(async () => {
      events.push("projects");
      return detection;
    });
    changed.discoverChanges = vi.fn(async () => {
      events.push("changes");
      return {
        base: {
          kind: "merge-base" as const,
          requestedRef: "origin/main",
          resolvedCommit: "b".repeat(40),
        },
        changes: [{ status: "modified" as const, path: "src/index.ts" }],
      };
    });
    const seen: DoctorContext[] = [];
    const makeDoctor = (id: string): Doctor => doctor(id, ["filesystem:read"], async (context) => {
      seen.push(context);
      return { status: "completed", findings: [], durationMs: 1 };
    });
    changed.createDoctors = () => [makeDoctor("project"), makeDoctor("full-context")];

    const result = await scanCodebase(request(false, {
      changed: true,
      baseRef: "origin/main",
    }), changed);

    expect(events).toEqual(["inventory", "manifests", "projects", "changes"]);
    expect(changed.discoverChanges).toHaveBeenCalledOnce();
    expect(changed.discoverChanges).toHaveBeenCalledWith({
      root: "/repo",
      baseRef: "origin/main",
    });
    expect(seen).toHaveLength(2);
    expect(seen.every(({ snapshot }) => snapshot.auditScope === seen[0]?.snapshot.auditScope)).toBe(true);
    expect(seen[0]?.snapshot.projects).toEqual(detection.projects);
    expect(result.auditScope).toMatchObject({
      mode: "changed",
      affectedProjectIds: ["root"],
    });
    expect(result.domainCoverage).toHaveLength(9);
  });

  it("omits baseRef from discovery when it was not requested", async () => {
    const deps = dependencies([]);

    await scanCodebase(request(false, { changed: true }), deps);

    expect(deps.discoverChanges).toHaveBeenCalledWith({ root: "/repo" });
  });

  it("rejects baseRef unless changed mode is enabled before doing discovery", async () => {
    const deps = dependencies([]);

    await expect(scanCodebase(request(false, { baseRef: "main" }), deps))
      .rejects.toThrow("baseRef can only be used when changed is true");
    expect(deps.inventoryWorkspace).not.toHaveBeenCalled();
    expect(deps.discoverChanges).not.toHaveBeenCalled();
  });

  it("propagates change discovery failures", async () => {
    const deps = dependencies([]);
    deps.discoverChanges = vi.fn(async () => {
      throw new Error("git discovery failed");
    });

    await expect(scanCodebase(request(false, { changed: true }), deps))
      .rejects.toThrow("git discovery failed");
  });

  it("skips Check Doctor by default and enables it with runChecks", async () => {
    const diagnose = vi.fn(async () => ({
      status: "completed" as const,
      findings: [],
      durationMs: 1,
    }));
    const check = doctor("checks", ["filesystem:read", "process:execute"], diagnose);

    const denied = await scanCodebase(request(false), dependencies([check]));
    const allowed = await scanCodebase(request(true), dependencies([check]));

    expect(denied.doctorRuns[0]).toMatchObject({ status: "skipped" });
    expect(allowed.doctorRuns[0]).toMatchObject({ status: "completed" });
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it("grants database networking independently through the scan request", async () => {
    const diagnose = vi.fn(async () => ({
      status: "completed" as const,
      findings: [],
      durationMs: 1,
    }));
    const database = doctor("database/rls", ["network:access"], diagnose);

    const denied = await scanCodebase(request(false), dependencies([database]));
    const allowed = await scanCodebase(
      request(false, { withDatabase: true }),
      dependencies([database]),
    );

    expect(denied.doctorRuns[0]).toMatchObject({ status: "skipped" });
    expect(allowed.doctorRuns[0]).toMatchObject({ status: "completed" });
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it("registers static and live RLS doctors only for the combined audit path", async () => {
    const discovery = {
      inventoryWorkspace: vi.fn(async () => inventory),
      loadManifests: vi.fn(async () => []),
      detectWorkspaceProjects: vi.fn(async () => detection),
    };

    const scanned = await scanCodebase(request(false), discovery);
    const audited = await scanCodebase(request(false, {
      includeDatabaseAudit: true,
      includeSecurityAudit: true,
      withDatabase: false,
      databaseSchemas: ["public"],
      databaseTimeoutMs: 10_000,
    }), discovery);

    expect(scanned.doctorRuns.map(({ doctorId }) => doctorId)).not.toContain("database/rls");
    expect(scanned.doctorRuns.map(({ doctorId }) => doctorId)).not.toContain("database/sql-rls");
    expect(scanned.doctorRuns.map(({ doctorId }) => doctorId)).not.toContain("security/secrets");
    expect(scanned.doctorRuns.map(({ doctorId }) => doctorId)).not.toContain("security/dependencies");
    expect(audited.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "security/secrets",
      status: "completed",
    }));
    expect(audited.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "security/dependencies",
      status: "completed",
    }));
    expect(audited.coverage).toContainEqual(expect.objectContaining({
      moduleId: "security/dependencies",
      status: "partial",
      limitations: ["package.json: valid package manifest is unavailable."],
    }));
    expect(audited.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/sql-rls",
      status: "completed",
    }));
    expect(audited.coverage).toContainEqual(expect.objectContaining({
      moduleId: "database/sql-rls",
      status: "not-applicable",
    }));
    expect(audited.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/rls",
      status: "skipped",
      skipReason: expect.stringContaining("network:access"),
    }));
    expect(scanned.domainCoverage.find(({ domain }) => domain === "database")).toMatchObject({
      status: "not-selected",
      coverageComplete: false,
    });
    expect(audited.domainCoverage.find(({ domain }) => domain === "database")).toMatchObject({
      status: "skipped",
      coverageComplete: false,
    });
  });

  it("reports planned checks without granting process execution", async () => {
    const deps = dependencies([]);
    deps.loadManifests = vi.fn(async () => [{
      kind: "package-json" as const,
      path: "package.json",
      status: "valid" as const,
      data: { scripts: { test: "vitest" } },
    }]);

    const result = await scanCodebase(request(false), deps);

    expect(result.plannedChecks).toEqual([expect.objectContaining({
      planId: "root:javascript:test",
      command: "npm run test",
    })]);
  });

  it("retains one doctor failure while preserving another doctor's finding", async () => {
    const broken = doctor("broken", ["filesystem:read"], async () => {
      throw new Error("doctor broke");
    });
    const healthy = doctor("healthy", ["filesystem:read"], async () => ({
      status: "completed",
      findings: [finding()],
      durationMs: 1,
    }));

    const result = await scanCodebase(request(false), dependencies([broken, healthy]));

    expect(result.findings).toHaveLength(1);
    expect(result.doctorRuns.find(({ doctorId }) => doctorId === "broken")).toMatchObject({
      status: "failed",
      error: { code: "doctor_execution_failed" },
    });
  });
});
