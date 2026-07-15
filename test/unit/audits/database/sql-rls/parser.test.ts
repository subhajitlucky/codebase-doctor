import { describe, expect, it } from "vitest";
import { parseSqlStatement } from "../../../../../src/audits/database/sql-rls/parser.js";
import type { SqlStatement } from "../../../../../src/audits/database/sql-rls/types.js";

function parse(text: string) {
  const statement: SqlStatement = {
    path: "supabase/migrations/001.sql",
    startLine: 7,
    endLine: 12,
    text,
  };
  return parseSqlStatement(statement);
}

describe("parseSqlStatement", () => {
  it("recognizes table creation with PostgreSQL identifier semantics", () => {
    expect(parse('create table if not exists "App".Documents (id uuid);')).toMatchObject({
      kind: "create-table",
      table: { schema: "App", name: "documents" },
    });
    expect(parse("create table documents (id uuid);")).toMatchObject({
      kind: "create-table",
      table: { schema: "public", name: "documents" },
    });
  });

  it.each([
    ["enable row level security", "set-rls", true],
    ["disable row level security", "set-rls", false],
    ["force row level security", "set-force-rls", true],
    ["no force row level security", "set-force-rls", false],
  ] as const)("recognizes ALTER TABLE %s", (clause, kind, enabled) => {
    expect(parse(`alter table public.documents ${clause};`)).toMatchObject({
      kind,
      table: { schema: "public", name: "documents" },
      enabled,
    });
  });

  it("recognizes policy defaults and balanced predicates", () => {
    const result = parse([
      'create policy "users read own" on public.documents',
      "  using ((select auth.uid()) = owner_id)",
      "  with check (owner_id = (select auth.uid()));",
    ].join("\n"));

    expect(result).toMatchObject({
      kind: "create-policy",
      name: "users read own",
      table: { schema: "public", name: "documents" },
      command: "ALL",
      permissive: true,
      roles: ["public"],
      usingExpression: "(select auth.uid()) = owner_id",
      checkExpression: "owner_id = (select auth.uid())",
    });
  });

  it("recognizes explicit policy options", () => {
    expect(parse([
      "create policy tenant_read on documents",
      "as restrictive for select to authenticated, \"SupportRole\"",
      "using (tenant_id = current_setting('app.tenant')::uuid);",
    ].join("\n"))).toMatchObject({
      kind: "create-policy",
      name: "tenant_read",
      command: "SELECT",
      permissive: false,
      roles: ["authenticated", "SupportRole"],
      usingExpression: "tenant_id = current_setting('app.tenant')::uuid",
      checkExpression: null,
    });
  });

  it("recognizes policy alteration and removal", () => {
    expect(parse("alter policy tenant_write on documents to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());"))
      .toMatchObject({
        kind: "alter-policy",
        name: "tenant_write",
        roles: ["authenticated"],
        usingExpression: "owner_id = auth.uid()",
        checkExpression: "owner_id = auth.uid()",
      });
    expect(parse('drop policy if exists "users read own" on public.documents;')).toMatchObject({
      kind: "drop-policy",
      name: "users read own",
      table: { schema: "public", name: "documents" },
    });
  });

  it("recognizes supported table grants and revokes", () => {
    expect(parse("grant select, truncate on table public.documents to authenticated, anon;")).toMatchObject({
      kind: "grant",
      privileges: ["SELECT", "TRUNCATE"],
      roles: ["authenticated", "anon"],
    });
    expect(parse("revoke truncate on public.documents from authenticated;")).toMatchObject({
      kind: "revoke",
      privileges: ["TRUNCATE"],
      roles: ["authenticated"],
    });
  });

  it("recognizes table removal", () => {
    expect(parse("drop table if exists public.documents cascade;")).toMatchObject({
      kind: "drop-table",
      table: { schema: "public", name: "documents" },
    });
  });

  it("distinguishes irrelevant DDL from unsupported relevant SQL", () => {
    expect(parse("create index documents_owner_idx on public.documents(owner_id);"))
      .toMatchObject({ kind: "ignored" });
    expect(parse("alter table public.documents add column archived boolean;"))
      .toMatchObject({ kind: "ignored" });
    expect(parse("alter table public.documents rename to archived_documents;"))
      .toMatchObject({ kind: "unsupported-relevant" });
    expect(parse("do $$ begin execute 'alter table public.documents disable row level security'; end $$;"))
      .toMatchObject({ kind: "unsupported-relevant" });
  });

  it("does not accept a supported prefix with meaning-changing trailing syntax", () => {
    expect(parse("alter table public.documents enable row level security, disable row level security;"))
      .toMatchObject({ kind: "unsupported-relevant" });
  });
});
