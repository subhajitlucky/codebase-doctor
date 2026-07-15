import { describe, expect, it } from "vitest";
import { parseSqlStatement } from "../../../../../src/audits/database/sql-rls/parser.js";
import { reduceSqlStream } from "../../../../../src/audits/database/sql-rls/reducer.js";
import type { SqlStatement } from "../../../../../src/audits/database/sql-rls/types.js";

function statements(...sql: string[]) {
  return sql.map((text, index) => parseSqlStatement({
    path: `migrations/${String(index + 1).padStart(3, "0")}.sql`,
    startLine: index + 10,
    endLine: index + 10,
    text,
  } satisfies SqlStatement));
}

describe("reduceSqlStream", () => {
  it("reduces create and RLS changes into final state with evidence", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "create table public.documents (id uuid);",
      "alter table public.documents enable row level security;",
      "alter table public.documents force row level security;",
    ));

    expect(result.tables[0]).toMatchObject({
      schema: "public",
      name: "documents",
      declaredInStream: true,
      dropped: false,
      rlsEnabled: true,
      forceRls: true,
      rlsEvidence: { path: "migrations/002.sql", startLine: 11 },
      forceRlsEvidence: { path: "migrations/003.sql", startLine: 12 },
    });
  });

  it("applies policy create, alter, replacement, and drop in order", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "create table documents (id uuid, owner_id uuid);",
      "create policy own on documents for select to anon using (true);",
      "alter policy own on documents to authenticated using (owner_id = auth.uid());",
      "alter policy own on documents to service_role;",
      "create policy write_own on documents for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());",
      "drop policy write_own on documents;",
    ));

    expect(result.tables[0]?.policies).toEqual([
      expect.objectContaining({
        name: "own",
        command: "SELECT",
        roles: ["service_role"],
        usingExpression: "owner_id = auth.uid()",
        evidence: expect.objectContaining({ path: "migrations/004.sql" }),
        rolesEvidence: expect.objectContaining({ path: "migrations/004.sql" }),
        usingEvidence: expect.objectContaining({ path: "migrations/003.sql" }),
      }),
    ]);
  });

  it("applies grants and revokes by role and privilege", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "grant select, truncate on table documents to anon, authenticated;",
      "revoke truncate on table documents from anon;",
    ));

    expect(result.tables[0]?.grants).toEqual([
      expect.objectContaining({ privilege: "SELECT", role: "anon" }),
      expect.objectContaining({ privilege: "SELECT", role: "authenticated" }),
      expect.objectContaining({ privilege: "TRUNCATE", role: "authenticated" }),
    ]);
  });

  it("keeps unproven state unknown for pre-existing tables", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "grant select on table legacy_documents to authenticated;",
    ));

    expect(result.tables[0]).toMatchObject({
      declaredInStream: false,
      rlsEnabled: "unknown",
      forceRls: "unknown",
    });
  });

  it("retains dropped state but removes stale policies and grants", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "create table documents (id uuid);",
      "create policy reads on documents for select using (true);",
      "grant select on documents to anon;",
      "drop table documents;",
    ));

    expect(result.tables[0]).toMatchObject({ dropped: true, policies: [], grants: [] });
  });

  it("reports only the corrected final state", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
      "alter table documents disable row level security;",
      "alter table documents enable row level security;",
    ));

    expect(result.tables[0]).toMatchObject({
      rlsEnabled: true,
      rlsEvidence: { path: "migrations/004.sql" },
    });
  });

  it("sorts tables and marks unsupported relevant SQL as partial", () => {
    const result = reduceSqlStream("root:migrations", statements(
      "create table zebra (id uuid);",
      "alter table zebra rename to archived_zebra;",
      "do $$ begin execute 'alter table alpha enable row level security'; end $$;",
      "create table alpha (id uuid);",
      "create index alpha_id_idx on alpha(id);",
    ));

    expect(result.tables.map(({ name }) => name)).toEqual(["alpha", "zebra"]);
    expect(result.coverage).toMatchObject({
      status: "partial",
      statementsExamined: 5,
      statementsRecognized: 2,
    });
    expect(result.coverage.limitations).toHaveLength(2);
  });
});
