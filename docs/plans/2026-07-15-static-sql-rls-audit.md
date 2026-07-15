# Static SQL/RLS Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically audit supported PostgreSQL migration streams for final expected RLS posture and report normalized findings plus honest coverage without credentials or network access.

**Architecture:** Add a built-in `database/sql-rls` doctor that discovers independent migration streams, lexically splits SQL, conservatively recognizes RLS-relevant PostgreSQL DDL, reduces each stream into final table/policy/grant state, and maps justified results into the shared finding contract. Extend schema-1 output with optional coverage records while keeping the live `database/rls` module separate.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, existing Codebase Doctor Doctor/finding/report contracts; no new SQL parser dependency.

---

### Task 1: Add the generic coverage contract

**Files:**
- Modify: `src/core/doctor.ts`
- Modify: `src/core/normalize.ts`
- Modify: `src/reporters/text.ts`
- Modify: `src/reporters/sarif.ts`
- Modify: `test/unit/core/normalize.test.ts`
- Modify: `test/unit/reporters/text.test.ts`
- Modify: `test/unit/reporters/sarif.test.ts`

**Step 1: Write failing coverage tests**

Add a doctor result with:

```ts
coverage: [{
  moduleId: "database/sql-rls",
  status: "partial",
  scope: "root:supabase/migrations",
  filesExamined: 2,
  statementsExamined: 8,
  statementsRecognized: 7,
  limitations: ["Dynamic SQL was not evaluated."],
}]
```

Assert normalization preserves and deterministically sorts coverage, text output
labels the stream partial, and SARIF stores coverage in `run.properties` without
creating a fake result.

**Step 2: Verify RED**

Run:

```bash
npx vitest run test/unit/core/normalize.test.ts test/unit/reporters/text.test.ts test/unit/reporters/sarif.test.ts
```

Expected: FAIL because `DoctorResult` and `ScanResult` have no coverage contract.

**Step 3: Implement the minimal contract**

Add:

```ts
export type CoverageStatus =
  | "completed"
  | "partial"
  | "not-applicable"
  | "skipped"
  | "failed";

export interface AuditCoverage {
  moduleId: string;
  status: CoverageStatus;
  scope: string;
  filesExamined: number;
  statementsExamined: number;
  statementsRecognized: number;
  limitations: readonly string[];
}
```

Allow `DoctorResult.coverage`, normalize it into optional top-level
`ScanResult.coverage`, and render it without treating partial coverage as a code
finding.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/doctor.ts src/core/normalize.ts src/reporters/text.ts src/reporters/sarif.ts test/unit/core/normalize.test.ts test/unit/reporters/text.test.ts test/unit/reporters/sarif.test.ts
git commit -m "feat: add audit coverage contract"
```

### Task 2: Discover independent PostgreSQL migration streams

**Files:**
- Create: `src/audits/database/sql-rls/types.ts`
- Create: `src/audits/database/sql-rls/discovery.ts`
- Create: `test/unit/audits/database/sql-rls/discovery.test.ts`

**Step 1: Write failing discovery tests**

Build snapshots containing Supabase, Prisma, Drizzle, generic, `db/migrations`,
and `database/migrations` SQL paths. Assert:

```ts
expect(discoverSqlStreams(snapshot)).toEqual([
  {
    id: "root:supabase/migrations",
    projectId: "root",
    root: "supabase/migrations",
    dialect: "postgresql",
    files: ["supabase/migrations/001_init.sql", "supabase/migrations/002_rls.sql"],
  },
]);
```

Cover monorepo project roots, independent streams, deterministic ordering,
non-SQL files, and `schema.sql` fallback only when no migration stream exists in
that project.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/audits/database/sql-rls/discovery.test.ts
```

Expected: FAIL because discovery does not exist.

**Step 3: Implement discovery from inventory paths**

Do not rescan the filesystem. Classify only `snapshot.files` already admitted by
inventory and exclusions. Associate paths with the deepest detected project root
and emit stable, separately ordered stream records.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/sql-rls/types.ts src/audits/database/sql-rls/discovery.ts test/unit/audits/database/sql-rls/discovery.test.ts
git commit -m "feat: discover PostgreSQL migration streams"
```

### Task 3: Split SQL safely with source locations

**Files:**
- Create: `src/audits/database/sql-rls/splitter.ts`
- Create: `test/unit/audits/database/sql-rls/splitter.test.ts`

**Step 1: Write failing splitter tests**

Test semicolons inside:

- single-quoted values with doubled quotes;
- double-quoted identifiers;
- line and nested block comments;
- `$$...$$` and `$tag$...$tag$` bodies; and
- nested predicate parentheses.

Assert statements retain `startLine`, `endLine`, and raw text. Assert malformed
quotes/comments/dollar bodies return a bounded diagnostic and `complete: false`
instead of throwing.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/audits/database/sql-rls/splitter.test.ts
```

Expected: FAIL because the splitter does not exist.

**Step 3: Implement a single-pass lexical state machine**

Use explicit states for normal text, quote types, line comment, nested block
comment depth, and dollar tag. Count newlines while scanning. Split only on a
top-level semicolon and never evaluate SQL.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/sql-rls/splitter.ts test/unit/audits/database/sql-rls/splitter.test.ts
git commit -m "feat: split PostgreSQL migration statements"
```

### Task 4: Recognize the supported RLS DDL subset

**Files:**
- Create: `src/audits/database/sql-rls/parser.ts`
- Create: `test/unit/audits/database/sql-rls/parser.test.ts`

**Step 1: Write failing parser tests**

Cover quoted and schema-qualified variants of:

```sql
create table public.documents (...);
alter table public.documents enable row level security;
alter table public.documents force row level security;
create policy "users read own" on public.documents
  as restrictive for select to authenticated
  using ((select auth.uid()) = owner_id);
grant select, truncate on table public.documents to authenticated;
revoke truncate on table public.documents from authenticated;
drop policy "users read own" on public.documents;
drop table public.documents;
```

Test PostgreSQL defaults for policy command, permissiveness, and roles. Test
balanced multiline `USING` and `WITH CHECK`. Classify dynamic/relevant SQL as
`unsupported-relevant` and unrelated indexes/columns as `ignored`.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/audits/database/sql-rls/parser.test.ts
```

Expected: FAIL because the parser does not exist.

**Step 3: Implement conservative token and balanced-clause parsing**

Return a discriminated union of supported operations, ignored statements, and
unsupported relevant statements. Preserve original identifier case/quoting
semantics after unescaping; default unquoted schema to `public`.

Do not accept a partial prefix as a supported statement. If trailing syntax
changes meaning, classify the whole relevant statement unsupported.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/sql-rls/parser.ts test/unit/audits/database/sql-rls/parser.test.ts
git commit -m "feat: parse static RLS migration DDL"
```

### Task 5: Reduce migrations into final expected state

**Files:**
- Create: `src/audits/database/sql-rls/reducer.ts`
- Create: `test/unit/audits/database/sql-rls/reducer.test.ts`

**Step 1: Write failing reducer tests**

Assert ordered operations produce final table state for:

- create then enable/force RLS;
- create, replace/alter, and drop policy;
- grant then revoke privileges;
- pre-existing tables with unknown initial state;
- create then drop table;
- unsafe early state corrected by a later migration; and
- unsupported rename/dynamic SQL producing partial coverage.

Verify evidence points to the statement that established the final property.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/audits/database/sql-rls/reducer.test.ts
```

Expected: FAIL because the reducer does not exist.

**Step 3: Implement immutable-looking deterministic reduction**

Use a map keyed by exact normalized schema/table identity. Created tables begin
with RLS and FORCE disabled; referenced pre-existing tables begin unknown. Apply
operations in stream/file/statement order, then return sorted final state and
coverage counters.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/sql-rls/reducer.ts test/unit/audits/database/sql-rls/reducer.test.ts
git commit -m "feat: reduce SQL migrations into RLS state"
```

### Task 6: Analyze static state without inventing catalog facts

**Files:**
- Create: `src/audits/database/sql-rls/analyzer.ts`
- Create: `test/unit/audits/database/sql-rls/analyzer.test.ts`

**Step 1: Write failing analyzer tests**

Test namespaced findings for:

- created table with RLS disabled;
- explicit application grant with disabled RLS;
- enabled RLS with no policies;
- public unconditional read/write;
- missing/effectively unconditional write checks;
- multiple permissive policies;
- public permissive policy;
- explicit application `TRUNCATE`; and
- missing FORCE RLS information.

Assert direct supported SQL has real file/line location, database evidence,
appropriate confidence, stable fingerprints, and suggested remediation. Assert
unknown schema privileges, role graphs, owners, default privileges, and bypass
attributes do not produce fabricated findings.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/audits/database/sql-rls/analyzer.test.ts
```

Expected: FAIL because the static analyzer does not exist.

**Step 3: Implement minimal static rules and safe reuse**

Reuse pure predicate/policy helpers only where semantics match exactly. Keep
static severity/confidence decisions in this module. Prefix rule IDs and doctor
ID with `database/sql-rls` and include stream ID in fingerprints.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/sql-rls/analyzer.ts test/unit/audits/database/sql-rls/analyzer.test.ts
git commit -m "feat: diagnose static SQL RLS posture"
```

### Task 7: Build and register the offline SQL/RLS doctor

**Files:**
- Create: `src/audits/database/sql-rls/doctor.ts`
- Create: `test/unit/audits/database/sql-rls/doctor.test.ts`
- Modify: `src/core/scan.ts`
- Modify: `test/unit/core/scan.test.ts`

**Step 1: Write failing doctor and orchestration tests**

Use temporary/injected SQL reads to assert the doctor:

- requires only `filesystem:read`;
- runs automatically for `audit` even without database permission;
- emits one coverage entry per stream;
- returns `not-applicable` when no stream exists;
- isolates malformed streams;
- enforces a per-file size ceiling; and
- never reads a path absent from the snapshot.

Assert `scan` remains backward-compatible and does not register the static
module.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/audits/database/sql-rls/doctor.test.ts test/unit/core/scan.test.ts
```

Expected: FAIL because the doctor is not registered.

**Step 3: Implement doctor and audit-only registration**

Inject a bounded UTF-8 file reader for unit tests. Register
`database/sql-rls` whenever `includeDatabaseAudit` is true, independently of
`withDatabase`. Keep the live doctor permission behavior unchanged.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/sql-rls/doctor.ts test/unit/audits/database/sql-rls/doctor.test.ts src/core/scan.ts test/unit/core/scan.test.ts
git commit -m "feat: register offline SQL RLS auditing"
```

### Task 8: Prove end-to-end CLI coverage and compatibility

**Files:**
- Create: `test/fixtures/sql-rls/unsafe/supabase/migrations/001_init.sql`
- Create: `test/fixtures/sql-rls/safe/prisma/migrations/001_init/migration.sql`
- Create: `test/fixtures/sql-rls/partial/migrations/001_dynamic.sql`
- Modify: `test/integration/cli-audit.test.ts`
- Modify: `test/integration/cli-scan.test.ts`
- Modify: `test/unit/reporters/json.test.ts`

**Step 1: Write failing CLI fixture tests**

Assert:

- unsafe offline audit emits `database/sql-rls/*` findings without credentials;
- safe offline audit completes without high findings;
- dynamic SQL reports partial coverage;
- live `database/rls` remains skipped without permission;
- `scan` does not run either audit module; and
- JSON schema version remains `1` with the optional coverage field.

**Step 2: Verify RED**

```bash
npx vitest run test/integration/cli-audit.test.ts test/integration/cli-scan.test.ts test/unit/reporters/json.test.ts
```

Expected: FAIL until the fixtures flow through the full command.

**Step 3: Make the smallest integration corrections**

Fix only wiring, ordering, or reporter issues revealed by the end-to-end tests.
Do not broaden SQL grammar in this task.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add test/fixtures/sql-rls test/integration/cli-audit.test.ts test/integration/cli-scan.test.ts test/unit/reporters/json.test.ts
git commit -m "test: verify offline SQL RLS auditing"
```

### Task 9: Update public exports and agent guidance

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `.agents/skills/codebase-doctor/SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `test/unit/skill-contract.test.ts`
- Modify: `test/integration/package-report-output.test.ts`

**Step 1: Write failing contract tests**

Require exports for `AuditCoverage` and `CoverageStatus`. Require the skill and
README to explain automatic offline SQL auditing, partial coverage, separate live
permission, and the distinction between expected migration state and observed
database state.

**Step 2: Verify RED**

```bash
npx vitest run test/unit/skill-contract.test.ts test/integration/package-report-output.test.ts
```

Expected: FAIL against old public guidance.

**Step 3: Update exports and documentation**

Document shipped behavior only after integration tests pass. Keep unsupported
dialects and dynamic SQL limitations prominent. Add an Unreleased changelog
entry; do not bump or publish a version.

**Step 4: Verify GREEN**

Run the Step 2 command and `npm run typecheck`. Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts README.md docs/architecture.md .agents/skills/codebase-doctor/SKILL.md CHANGELOG.md test/unit/skill-contract.test.ts test/integration/package-report-output.test.ts
git commit -m "docs: document offline SQL RLS coverage"
```

### Task 10: Full verification and release-boundary check

**Files:**
- Modify only files required by verified failures.

**Step 1: Run normal and package CI**

```bash
npm run ci:full
```

Expected: all source and package tests, typecheck, build, packed installation,
and dependency audit PASS.

**Step 2: Run live PostgreSQL regression integration**

```bash
CODEBASE_DOCTOR_ALLOW_DESTRUCTIVE_TESTS=1 npm run test:rls-integration
```

Expected: unsafe/safe live PostgreSQL 16 integration PASS, proving the static
module did not regress the live module.

**Step 3: Self-audit without credentials**

```bash
node dist/cli.js audit . --exclude 'test/fixtures/**' --json --fail-on none
node dist/cli.js audit . --exclude 'test/fixtures/**' --run-checks --json --fail-on none
```

Expected: repository and configured checks complete, static SQL coverage is
not-applicable for the project, and live RLS coverage is visibly skipped.

**Step 4: Inspect final state**

```bash
git diff --check
git status --short
git log --oneline -15
```

Expected: no whitespace errors or unintended files. Do not bump, publish, tag,
or push as part of this implementation plan.
