import { describe, expect, it } from "vitest";
import { splitSql } from "../../../../../src/audits/database/sql-rls/splitter.js";

describe("splitSql", () => {
  it("splits top-level statements with source lines", () => {
    const result = splitSql("migrations/001.sql", [
      "create table public.a (id int);",
      "",
      "alter table public.a enable row level security;",
    ].join("\n"));

    expect(result.complete).toBe(true);
    expect(result.statements).toEqual([
      expect.objectContaining({ startLine: 1, endLine: 1, text: "create table public.a (id int);" }),
      expect.objectContaining({ startLine: 3, endLine: 3 }),
    ]);
  });

  it("ignores semicolons inside quotes, comments, dollar bodies, and parentheses", () => {
    const source = [
      "-- ignored ; comment",
      "create table \"odd;table\" (value text default 'a;''b');",
      "/* outer ; /* nested ; */ done */",
      "do $body$ begin perform 'inside;body'; end $body$;",
      "create policy p on public.docs using ((note = 'x;y'));",
    ].join("\n");

    const result = splitSql("schema.sql", source);

    expect(result.complete).toBe(true);
    expect(result.statements).toHaveLength(3);
    expect(result.statements[0]?.text).toContain('"odd;table"');
    expect(result.statements[1]?.text).toContain("inside;body");
    expect(result.statements[2]?.startLine).toBe(5);
  });

  it.each([
    ["unterminated string", "select 'missing;"],
    ["unterminated block comment", "select 1 /* missing"],
    ["unterminated dollar body", "do $x$ begin;"],
    ["unbalanced parentheses", "select (1;"],
  ])("returns a bounded diagnostic for %s", (_label, source) => {
    const result = splitSql("broken.sql", source);

    expect(result.complete).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ path: "broken.sql" });
    expect(result.diagnostics[0]?.message.length).toBeLessThan(200);
  });

  it("supports empty dollar-quote tags", () => {
    const result = splitSql("function.sql", "do $$ begin perform 1; end $$; select 2;");

    expect(result.complete).toBe(true);
    expect(result.statements).toHaveLength(2);
  });
});
