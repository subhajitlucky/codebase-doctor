import { describe, expect, it } from "vitest";
import { analyzeStaticSqlRls } from "../../../../../src/audits/database/sql-rls/analyzer.js";
import { parseSqlStatement } from "../../../../../src/audits/database/sql-rls/parser.js";
import { reduceSqlStream } from "../../../../../src/audits/database/sql-rls/reducer.js";

function analyze(sql: readonly string[], lineOffset = 0) {
  const operations = sql.map((text, index) => parseSqlStatement({
    path: `supabase/migrations/${String(index + 1).padStart(3, "0")}.sql`,
    startLine: lineOffset + index + 1,
    endLine: lineOffset + index + 1,
    text,
  }));
  return analyzeStaticSqlRls(reduceSqlStream("root:supabase/migrations", operations));
}

function ids(sql: readonly string[]) {
  return analyze(sql).map(({ ruleId }) => ruleId);
}

describe("analyzeStaticSqlRls", () => {
  it("reports a table created with RLS disabled", () => {
    const findings = analyze(["create table documents (id uuid);"]);

    expect(findings).toContainEqual(expect.objectContaining({
      ruleId: "database/sql-rls/rls-disabled",
      doctorId: "database/sql-rls",
      severity: "medium",
      confidence: "high",
      location: { path: "supabase/migrations/001.sql", line: 1 },
      remediation: expect.stringContaining("enable row level security"),
    }));
    expect(findings[0]?.evidence).toContainEqual(expect.objectContaining({
      type: "database",
      schema: "public",
      table: "documents",
    }));
    expect(findings.every((finding) =>
      finding.impact?.trim() !== "" &&
      finding.remediationConstraints?.every((constraint) => constraint.trim() !== "") === true &&
      finding.verification?.command === "codebase-doctor audit . --format json" &&
      /fingerprint.*absent.*coverage.*completed/i.test(finding.verification.expected)
    )).toBe(true);
  });

  it("raises severity when an application-facing grant reaches an RLS-disabled table", () => {
    expect(analyze([
      "create table documents (id uuid);",
      "grant select on documents to authenticated;",
    ])).toContainEqual(expect.objectContaining({
      ruleId: "database/sql-rls/rls-disabled-exposed",
      severity: "high",
      location: { path: "supabase/migrations/002.sql", line: 2 },
    }));
  });

  it("reports enabled RLS with no known policies", () => {
    expect(ids([
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
    ])).toContain("database/sql-rls/rls-enabled-no-policies");
  });

  it("reports unconditional public reads and writes", () => {
    const findingIds = ids([
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
      "create policy public_reads on documents for select to anon using (true);",
      "create policy public_writes on documents for insert to public with check (1 = 1);",
    ]);

    expect(findingIds).toContain("database/sql-rls/public-unconditional-read");
    expect(findingIds).toContain("database/sql-rls/public-unconditional-write");
    expect(findingIds).toContain("database/sql-rls/public-permissive-policy");
  });

  it("reports missing or effectively unconditional write checks", () => {
    const findingIds = ids([
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
      "create policy inserts on documents for insert to authenticated;",
      "create policy updates on documents for update to authenticated using (true);",
    ]);

    expect(findingIds.filter((id) => id === "database/sql-rls/write-policy-missing-check"))
      .toHaveLength(2);
  });

  it("reports an explicit unconditional application write check", () => {
    expect(ids([
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
      "create policy inserts on documents for insert to authenticated with check (true);",
    ])).toContain("database/sql-rls/write-policy-unconditional-check");
  });

  it("reports multiple permissive policies for the same role and command", () => {
    expect(ids([
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
      "create policy own_docs on documents for select to authenticated using (owner_id = auth.uid());",
      "create policy team_docs on documents for select to authenticated using (team_id = current_setting('app.team')::uuid);",
    ])).toContain("database/sql-rls/multiple-permissive-policies");
  });

  it("reports explicit application-facing TRUNCATE", () => {
    expect(analyze([
      "create table documents (id uuid);",
      "grant truncate on documents to authenticated;",
    ])).toContainEqual(expect.objectContaining({
      ruleId: "database/sql-rls/reachable-truncate",
      severity: "high",
    }));
  });

  it("reports explicitly disabled FORCE RLS as informational hardening", () => {
    expect(analyze([
      "create table documents (id uuid);",
      "alter table documents enable row level security;",
      "create policy own_docs on documents for select to authenticated using (owner_id = auth.uid());",
    ])).toContainEqual(expect.objectContaining({
      ruleId: "database/sql-rls/force-rls-disabled",
      severity: "info",
    }));
  });

  it("uses stable logical fingerprints independent of source line movement", () => {
    const first = analyze(["create table documents (id uuid);"], 0)
      .find(({ ruleId }) => ruleId.endsWith("/rls-disabled"));
    const moved = analyze(["create table documents (id uuid);"], 40)
      .find(({ ruleId }) => ruleId.endsWith("/rls-disabled"));

    expect(first?.fingerprint).toBe(moved?.fingerprint);
  });

  it("does not invent findings from unknown catalog or pre-existing state", () => {
    const findings = analyze([
      "alter table legacy_documents enable row level security;",
      "grant select on legacy_documents to internal_worker;",
    ]);

    expect(findings).toEqual([]);
  });
});
