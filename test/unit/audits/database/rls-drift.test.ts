import { describe, expect, it, vi } from "vitest";
import { createRlsDriftDoctor } from "../../../../src/audits/database/rls-drift/doctor.js";
import type { CatalogSnapshot, PolicySnapshot } from "../../../../src/audits/database/rls/types.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../src/scope/types.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function snapshot(
  paths: readonly string[],
  auditScope: AuditScope = fullAuditScope(),
): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 100 })),
    manifests: [],
    projects: [{
      id: "root",
      root: ".",
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: ["supabase"],
      manifestPaths: [],
      executionSupport: "supported",
    }],
    workspaces: [],
    auditScope,
  };
}

function changedScope(): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes: [],
    affectedProjectIds: [],
    reasons: [],
    limitations: [],
  };
}

function catalog(overrides: Partial<CatalogSnapshot>): CatalogSnapshot {
  return {
    tables: [],
    policies: [],
    relationPrivileges: [],
    ...overrides,
  };
}

function policy(overrides: Partial<PolicySnapshot>): PolicySnapshot {
  return {
    schema: "public",
    table: "logs",
    name: "live_only",
    command: "SELECT",
    permissive: true,
    roles: ["authenticated"],
    usingExpression: "true",
    checkExpression: null,
    ...overrides,
  };
}

const MIGRATION_PATH = "supabase/migrations/001.sql";

describe("RLS drift doctor", () => {
  it("requires live database access", () => {
    expect(createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
    }).capabilities).toEqual(["network:access"]);
  });

  it("reports static-to-live drift for RLS, policies, and grants", async () => {
    const sql = [
      "create table public.accounts (id uuid);",
      "alter table public.accounts enable row level security;",
      "alter table public.accounts force row level security;",
      "create policy own on public.accounts for select to authenticated using (true);",
      "grant select on table public.accounts to authenticated;",
    ].join("\n");
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      readSqlFile: vi.fn(async () => sql),
      loadCatalog: vi.fn(async () => catalog({
        tables: [{ schema: "public", name: "accounts", rlsEnabled: false, forceRls: false, isPartitioned: false, estimatedRows: 0 }],
      })),
    });

    const result = await doctor.diagnose({
      snapshot: snapshot([MIGRATION_PATH]),
      allowedCapabilities: new Set(["network:access"]),
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual([
      "database/rls-drift/force-rls-disabled-live",
      "database/rls-drift/grant-missing-live",
      "database/rls-drift/policy-missing-live",
      "database/rls-drift/rls-disabled-live",
    ]);
    expect(result.findings.every((finding) => finding.doctorId === "database/rls-drift")).toBe(true);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "database/rls-drift",
      scope: "root:supabase/migrations",
      status: "completed",
      filesExamined: 1,
    }));
  });

  it("reports live-only RLS enablement and unmanaged live policies", async () => {
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      readSqlFile: vi.fn(async () => "create table public.logs (id uuid);"),
      loadCatalog: vi.fn(async () => catalog({
        tables: [{ schema: "public", name: "logs", rlsEnabled: true, forceRls: false, isPartitioned: false, estimatedRows: 12 }],
        policies: [policy({})],
      })),
    });

    const result = await doctor.diagnose({
      snapshot: snapshot([MIGRATION_PATH]),
      allowedCapabilities: new Set(["network:access"]),
    });

    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual([
      "database/rls-drift/policy-unmanaged-live",
      "database/rls-drift/rls-enabled-live-only",
    ]);
  });

  it("reports a declared table missing from the live catalog", async () => {
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      readSqlFile: vi.fn(async () => "create table public.gone (id uuid);"),
      loadCatalog: vi.fn(async () => catalog({})),
    });

    const result = await doctor.diagnose({
      snapshot: snapshot([MIGRATION_PATH]),
      allowedCapabilities: new Set(["network:access"]),
    });

    const finding = result.findings.find(
      (entry) => entry.ruleId === "database/rls-drift/table-missing-live",
    );
    expect(finding?.severity).toBe("high");
    expect(finding?.evidence).toContainEqual(expect.objectContaining({
      type: "database",
      schema: "public",
      table: "gone",
    }));
  });

  it("keeps coverage partial when static SQL cannot be read", async () => {
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      readSqlFile: vi.fn(async () => {
        throw new Error("permission denied");
      }),
      loadCatalog: vi.fn(async () => catalog({})),
    });

    const result = await doctor.diagnose({
      snapshot: snapshot([MIGRATION_PATH]),
      allowedCapabilities: new Set(["network:access"]),
    });

    expect(result.findings).toHaveLength(0);
    const moduleCoverage = result.coverage?.find(
      (entry) => entry.moduleId === "database/rls-drift",
    );
    expect(moduleCoverage?.status).toBe("partial");
    expect(moduleCoverage?.limitations.join(" ")).toContain("unable to read inventoried SQL file");
  });

  it("skips comparison for schemas outside the live selection", async () => {
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      readSqlFile: vi.fn(async () => "create table auth.users (id uuid);"),
      loadCatalog: vi.fn(async () => catalog({})),
    });

    const result = await doctor.diagnose({
      snapshot: snapshot([MIGRATION_PATH]),
      allowedCapabilities: new Set(["network:access"]),
    });

    expect(result.findings).toHaveLength(0);
    const moduleCoverage = result.coverage?.find(
      (entry) => entry.moduleId === "database/rls-drift",
    );
    expect(moduleCoverage?.status).toBe("partial");
    expect(moduleCoverage?.limitations.join(" ")).toContain("outside the live audit schema selection");
  });

  it("reports not-selected for changed audits", async () => {
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      readSqlFile: vi.fn(async () => "create table public.logs (id uuid);"),
      loadCatalog: vi.fn(async () => catalog({})),
    });

    const result = await doctor.diagnose({
      snapshot: snapshot([MIGRATION_PATH], changedScope()),
      allowedCapabilities: new Set(["network:access"]),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "database/rls-drift",
      status: "not-selected",
    }));
  });

  it("does not support snapshots without a SQL migration stream", () => {
    const doctor = createRlsDriftDoctor({
      schemas: ["public"],
      statementTimeoutMs: 1_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
    });
    expect(doctor.supports(snapshot(["src/app.ts"]))).toBe(false);
    expect(doctor.supports(snapshot([MIGRATION_PATH]))).toBe(true);
  });
});
