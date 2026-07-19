import { describe, expect, it } from "vitest";
import { analyzeDrizzleRawSqlDates } from "../../../../../src/audits/database/drizzle/analyzer.js";

function analyze(source: string, path = "src/query.ts") {
  return analyzeDrizzleRawSqlDates(path, source);
}

describe("analyzeDrizzleRawSqlDates", () => {
  it("proves direct Date construction in an imported Drizzle sql template", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      'const query = sql`updated_at <= ${new Date()}`;',
    ].join("\n"));

    expect(result).toEqual({
      status: "completed",
      matches: [{
        line: 2,
        column: 35,
        evidenceClass: "direct-date-construction",
        sqlBinding: "sql",
      }],
      limitations: [],
    });
  });

  it("resolves an aliased sql import and immutable Date const", () => {
    const result = analyze([
      'import { sql as drizzleSql } from "drizzle-orm";',
      "const cutoff = new Date(0);",
      'drizzleSql`created_at <= ${cutoff}`;',
    ].join("\n"));

    expect(result.matches).toEqual([
      {
        line: 3,
        column: 28,
        evidenceClass: "immutable-date-binding",
        sqlBinding: "drizzleSql",
      },
    ]);
  });

  it("proves exact Date annotations on bindings and parameters", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const first: Date = getCutoff();",
      "function recover(second: Date) {",
      "  return sql`${first} ${second}`;",
      "}",
    ].join("\n"));

    expect(result.matches).toEqual([
      { line: 4, column: 16, evidenceClass: "declared-date-type", sqlBinding: "sql" },
      { line: 4, column: 25, evidenceClass: "declared-date-type", sqlBinding: "sql" },
    ]);
  });

  it("proves exact Date assertions", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "declare const unknownValue: unknown;",
      "sql`${unknownValue as Date} ${<Date>unknownValue}`;",
    ].join("\n"));

    expect(result.matches.map(({ evidenceClass }) => evidenceClass)).toEqual([
      "date-type-assertion",
      "date-type-assertion",
    ]);
  });

  it("does not treat a project-defined Date type as the built-in Date", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "type Date = string;",
      "declare const cutoff: Date;",
      "declare const unknownValue: unknown;",
      "sql`${cutoff} ${unknownValue as Date}`;",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 5, column: 7 },
      { code: "unresolved-interpolation", line: 5, column: 17 },
    ]);
  });

  it("does not mistake Date strings, numbers, or date-like names for Date objects", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const date = Date();",
      "const epoch = Date.now();",
      'const text = new Date().toISOString();',
      'const expirationDate = "2026-01-01";',
      "sql`${date} ${epoch} ${text} ${expirationDate}`;",
    ].join("\n"));

    expect(result.matches).toEqual([]);
  });

  it("respects lexical shadowing of sql and Date", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "sql`${new Date()}`;",
      "{",
      "  const sql = (parts: TemplateStringsArray) => parts;",
      "  sql`${new Date()}`;",
      "}",
      "function local(Date: new () => object) {",
      "  sql`${new Date()}`;",
      "}",
    ].join("\n"));

    expect(result.matches).toEqual([
      { line: 2, column: 7, evidenceClass: "direct-date-construction", sqlBinding: "sql" },
    ]);
  });

  it("respects catch, method-parameter, and loop shadowing of sql", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "try {} catch (sql) { sql`${new Date()}`; }",
      "class Queries { run(sql: (parts: TemplateStringsArray) => unknown) { sql`${new Date()}`; } }",
      "for (const sql of []) { sql`${new Date()}`; }",
    ].join("\n"));

    expect(result).toEqual({ status: "completed", matches: [], limitations: [] });
  });

  it("respects switch and static-block lexical shadowing of sql", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "switch (kind) { case 1: const sql = localTag; sql`${new Date()}`; break; }",
      "class Queries { static { const sql = localTag; sql`${new Date()}`; } }",
    ].join("\n"));

    expect(result).toEqual({ status: "completed", matches: [], limitations: [] });
  });

  it("treats values with writes before use as unresolved instead of findings", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "let cutoff: Date = new Date();",
      "cutoff = getCutoff();",
      "sql`${cutoff}`;",
      "let second = new Date();",
      "second++;",
      "sql`${second}`;",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 4, column: 7 },
      { code: "unresolved-interpolation", line: 7, column: 7 },
    ]);
  });

  it("does not call a const immutable when any later write exists", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const cutoff = new Date();",
      "sql`${cutoff}`;",
      "cutoff = new Date(1);",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 3, column: 7 },
    ]);
  });

  it("rejects typed Date proof when a later nested function can reassign it", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "let cutoff: Date = new Date();",
      "sql`${cutoff}`;",
      "function replaceCutoff() { cutoff = new Date(1); }",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 3, column: 7 },
    ]);
  });

  it("records non-declaration for-of and for-in targets as writes", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "let cutoff: Date = new Date();",
      "let second: Date = new Date();",
      "for (cutoff of values) {}",
      "for (second in values) {}",
      "sql`${cutoff} ${second}`;",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 6, column: 7 },
      { code: "unresolved-interpolation", line: 6, column: 17 },
    ]);
  });

  it("does not prove a Date binding used in its temporal dead zone", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "sql`${cutoff}`;",
      "const cutoff = new Date();",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 2, column: 7 },
    ]);
  });

  it("ignores sql tags imported from unrelated packages", () => {
    const result = analyze([
      'import { sql } from "another-package";',
      "sql`${new Date()}`;",
    ].join("\n"));

    expect(result).toEqual({ status: "completed", matches: [], limitations: [] });
  });

  it("exempts only the explicit two-argument sql.param encoder wrapper", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const cutoff = new Date();",
      "const encoder = { mapToDriverValue: (value: Date) => value.toISOString() };",
      "sql`${sql.param(cutoff, encoder)} ${sql.param(cutoff)}`;",
    ].join("\n"));

    expect(result.matches).toEqual([
      { line: 4, column: 37, evidenceClass: "immutable-date-binding", sqlBinding: "sql" },
    ]);
  });

  it("does not exempt a lookalike wrapper unrelated to the imported sql binding", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const cutoff = new Date();",
      "const other = { param: (value: unknown, encoder: unknown) => value };",
      "sql`${other.param(cutoff, {})}`;",
    ].join("\n"));

    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 4, column: 7 },
    ]);
  });

  it("does not report obvious Drizzle table and column references as unresolved", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      'import { users } from "./schema.js";',
      "sql`${users} ${users.createdAt} ${42} ${\"safe\"}`;",
    ].join("\n"));

    expect(result).toEqual({ status: "completed", matches: [], limitations: [] });
  });

  it("recognizes structure only when operators and columns have proven bindings", () => {
    const result = analyze([
      'import { lte, pgTable, sql } from "drizzle-orm";',
      'import { users } from "./schema.js";',
      'const localTable = pgTable("local", {});',
      "sql`${lte(users.createdAt, new Date())} ${localTable.createdAt}`;",
    ].join("\n"));

    expect(result).toEqual({ status: "completed", matches: [], limitations: [] });
  });

  it("keeps value-like member access and local operator lookalikes unresolved", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "function lte(value: unknown) { return value; }",
      "function pgTable(name: string) { return { name }; }",
      'const impostorTable = pgTable("local");',
      "function query(params: { cutoff: unknown }) {",
      "  return sql`${params.cutoff} ${lte(params.cutoff)} ${impostorTable.createdAt}`;",
      "}",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 6, column: 16 },
      { code: "unresolved-interpolation", line: 6, column: 33 },
      { code: "unresolved-interpolation", line: 6, column: 55 },
    ]);
  });

  it("bounds scalar alias following for self and cyclic aliases", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const self = self;",
      "const first = second;",
      "const second = first;",
      "sql`${self} ${first}`;",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 5, column: 7 },
      { code: "unresolved-interpolation", line: 5, column: 15 },
    ]);
  });

  it("bounds Date proof across a long acyclic const chain", () => {
    const aliases = Array.from(
      { length: 96 },
      (_, index) => `const date${index + 1} = date${index};`,
    );
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "const date0 = new Date();",
      ...aliases,
      "sql`${date96}`;",
    ].join("\n"));

    expect(result.matches).toEqual([]);
    expect(result.status).toBe("partial");
    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 99, column: 7 },
    ]);
  });

  it("reports unknown value-position interpolation without exposing its value", () => {
    const result = analyze([
      'import { sql } from "drizzle-orm";',
      "function query(cutoff: unknown) {",
      "  return sql`${cutoff}`;",
      "}",
    ].join("\n"));

    expect(result.limitations).toEqual([
      { code: "unresolved-interpolation", line: 3, column: 16 },
    ]);
    expect(JSON.stringify(result)).not.toContain("cutoff");
  });

  it("returns a bounded partial result on parse failure", () => {
    const result = analyze('import { sql } from "drizzle-orm"; sql`${`');

    expect(result).toEqual({
      status: "partial",
      matches: [],
      limitations: [{ code: "parse-failure" }],
    });
  });

  it("sorts evidence deterministically by source position", () => {
    const source = [
      'import { sql } from "drizzle-orm";',
      "const later = new Date();",
      "sql`${later} ${new Date()}`;",
    ].join("\n");

    expect(analyze(source).matches).toEqual(analyze(source).matches);
    expect(analyze(source).matches.map(({ column }) => column)).toEqual([7, 16]);
  });

  it("stops cycle-safely at the configured AST budget", () => {
    const source = [
      'import { sql } from "drizzle-orm";',
      ...Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`),
      "sql`${new Date()}`;",
    ].join("\n");
    const result = analyzeDrizzleRawSqlDates("src/large.ts", source, {
      maxNodes: 24,
      maxDepth: 16,
      maxLimitations: 2,
    });

    expect(result.status).toBe("partial");
    expect(result.limitations).toContainEqual({ code: "analysis-budget-exceeded" });
    expect(result.limitations.length).toBeLessThanOrEqual(2);
  });

  it("bounds deeply nested binding-pattern predeclaration", () => {
    const pattern = `${"[".repeat(96)}value${"]".repeat(96)}`;
    const result = analyzeDrizzleRawSqlDates(
      "src/deep-pattern.ts",
      ['import { sql } from "drizzle-orm";', `const ${pattern} = input;`, "sql`${new Date()}`;"].join("\n"),
      { maxNodes: 1_000, maxDepth: 24, maxLimitations: 2 },
    );

    expect(result).toEqual({
      status: "partial",
      matches: [],
      limitations: [{ code: "analysis-budget-exceeded" }],
    });
  });

  it("bounds large declaration predeclaration using the analysis budget", () => {
    const declarations = Array.from(
      { length: 80 },
      (_, index) => `const value${index} = ${index};`,
    );
    const result = analyzeDrizzleRawSqlDates(
      "src/wide-declarations.ts",
      ['import { sql } from "drizzle-orm";', ...declarations, "sql`${new Date()}`;"].join("\n"),
      { maxNodes: 32, maxDepth: 128, maxLimitations: 2 },
    );

    expect(result).toEqual({
      status: "partial",
      matches: [],
      limitations: [{ code: "analysis-budget-exceeded" }],
    });
  });
});
