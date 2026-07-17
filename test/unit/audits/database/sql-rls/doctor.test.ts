import { describe, expect, it, vi } from "vitest";
import { createSqlRlsDoctor } from "../../../../../src/audits/database/sql-rls/doctor.js";
import { runDoctors } from "../../../../../src/core/registry.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";

function snapshot(files: Array<{ path: string; size?: number }>): ProjectSnapshot {
  return {
    root: "/repo",
    files: files.map(({ path, size = 100 }) => ({ path, size, kind: "file" as const })),
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

describe("static SQL RLS doctor", () => {
  it("requires only filesystem read permission", () => {
    expect(createSqlRlsDoctor().capabilities).toEqual(["filesystem:read"]);
  });

  it("audits every discovered stream and emits one coverage entry per stream", async () => {
    const reader = vi.fn(async (_root: string, path: string) => ({
      "supabase/migrations/001.sql": "create table public.docs (id uuid);",
      "prisma/migrations/001/migration.sql": [
        "create table public.accounts (id uuid);",
        "alter table public.accounts enable row level security;",
        "create policy own on public.accounts for select to authenticated using (true);",
      ].join("\n"),
    })[path]!);
    const doctor = createSqlRlsDoctor({ readSqlFile: reader });

    const [entry] = await runDoctors([doctor], snapshot([
      { path: "supabase/migrations/001.sql" },
      { path: "prisma/migrations/001/migration.sql" },
    ]), { runChecks: false, withDatabase: false });

    expect(entry?.result.status).toBe("completed");
    expect(entry?.result.coverage?.map(({ scope }) => scope)).toEqual([
      "root:prisma/migrations",
      "root:supabase/migrations",
    ]);
    expect(entry?.result.findings).toContainEqual(expect.objectContaining({
      doctorId: "database/sql-rls",
      ruleId: "database/sql-rls/rls-disabled",
    }));
    expect(reader.mock.calls.map(([, path]) => path).sort()).toEqual([
      "prisma/migrations/001/migration.sql",
      "supabase/migrations/001.sql",
    ]);
  });

  it("returns not-applicable coverage when no migration stream exists", async () => {
    const reader = vi.fn();
    const [entry] = await runDoctors(
      [createSqlRlsDoctor({ readSqlFile: reader })],
      snapshot([{ path: "src/index.ts" }]),
      { runChecks: false, withDatabase: false },
    );

    expect(entry?.result).toMatchObject({
      status: "completed",
      findings: [],
      coverage: [expect.objectContaining({
        moduleId: "database/sql-rls",
        status: "not-applicable",
        scope: "root",
      })],
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("isolates malformed SQL as partial coverage without hiding other streams", async () => {
    const reader = vi.fn(async (_root: string, path: string) =>
      path.startsWith("migrations/")
        ? "do $body$ begin execute 'alter table docs disable row level security';"
        : "create table public.docs (id uuid);"
    );
    const [entry] = await runDoctors(
      [createSqlRlsDoctor({ readSqlFile: reader })],
      snapshot([
        { path: "migrations/001_dynamic.sql" },
        { path: "supabase/migrations/001.sql" },
      ]),
      { runChecks: false, withDatabase: false },
    );

    expect(entry?.result.coverage).toContainEqual(expect.objectContaining({
      scope: "root:migrations",
      status: "partial",
      limitations: expect.arrayContaining([expect.stringMatching(/unterminated dollar/i)]),
    }));
    expect(entry?.result.coverage).toContainEqual(expect.objectContaining({
      scope: "root:supabase/migrations",
      status: "completed",
    }));
    expect(entry?.result.findings).toContainEqual(expect.objectContaining({
      ruleId: "database/sql-rls/rls-disabled",
    }));
  });

  it("does not read oversized SQL files", async () => {
    const reader = vi.fn();
    const [entry] = await runDoctors(
      [createSqlRlsDoctor({ readSqlFile: reader, maxFileBytes: 32 })],
      snapshot([{ path: "supabase/migrations/001.sql", size: 33 }]),
      { runChecks: false, withDatabase: false },
    );

    expect(reader).not.toHaveBeenCalled();
    expect(entry?.result.coverage).toContainEqual(expect.objectContaining({
      status: "partial",
      filesExamined: 0,
      limitations: [expect.stringMatching(/size limit/i)],
    }));
  });

  it("never reads SQL paths absent from the inventory", async () => {
    const reader = vi.fn(async () => "create table docs (id uuid);");
    await runDoctors(
      [createSqlRlsDoctor({ readSqlFile: reader })],
      snapshot([{ path: "supabase/migrations/001.sql" }, { path: "secrets.sql" }]),
      { runChecks: false, withDatabase: false },
    );

    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith("/repo", "supabase/migrations/001.sql");
  });
});
