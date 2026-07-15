# Unified RLS Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicitly permitted live PostgreSQL RLS audit to the unified `codebase-doctor audit` command and normalize its results into the existing text, JSON, SARIF, baseline, and exit-code contracts.

**Architecture:** Migrate RLS Doctor's pure analyzer and read-only catalog loader into `src/audits/database/rls`, then adapt them through the existing built-in Doctor interface. Keep `scan` repository-only, add `audit` as the canonical combined command, and grant database networking independently through `--with-database`.

**Tech Stack:** TypeScript, Node.js 20+, Commander, `pg`, Vitest, tsup, PostgreSQL catalog SQL.

---

### Task 1: Add database evidence to the shared finding contract

**Files:**
- Modify: `src/core/findings.ts`
- Modify: `src/reporters/text.ts`
- Modify: `src/reporters/sarif.ts`
- Modify: `test/unit/reporters/text.test.ts`
- Modify: `test/unit/reporters/sarif.test.ts`

**Step 1: Write the failing reporter tests**

Create a finding whose evidence contains:

```ts
{
  type: "database",
  schema: "public",
  table: "documents",
  policy: "public write",
  detail: "The policy predicate is unconditional.",
}
```

Assert that text output identifies `public.documents` and that SARIF emits a
locationless result whose message or properties preserve the database scope.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/reporters/text.test.ts test/unit/reporters/sarif.test.ts
```

Expected: TypeScript or assertion failure because `database` is not a supported
evidence variant.

**Step 3: Add the minimal shared evidence type and rendering**

Extend `Evidence` with:

```ts
| {
    type: "database";
    schema: string;
    table?: string;
    policy?: string;
    detail: string;
  };
```

Render database evidence without creating a fake repository path. Keep SARIF
results locationless and include the scope in result properties or message text.

**Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/findings.ts src/reporters/text.ts src/reporters/sarif.ts test/unit/reporters/text.test.ts test/unit/reporters/sarif.test.ts
git commit -m "feat: add database finding evidence"
```

### Task 2: Migrate the pure RLS analyzer

**Files:**
- Create: `src/audits/database/rls/types.ts`
- Create: `src/audits/database/rls/analyzer.ts`
- Create: `test/unit/audits/database/rls/analyzer.test.ts`

**Step 1: Port the analyzer contract tests**

Bring the behavior tests from `/home/subhajit/project/rls-doctor/tests/analyzer.test.ts`
into the Codebase Doctor tree. Preserve tests for:

- RLS disabled with and without reachable application privileges;
- schema `USAGE` and relation privilege composition;
- inherited and `SET ROLE` reachability;
- `SUPERUSER`, `BYPASSRLS`, and `TRUNCATE` behavior;
- command-aware `USING` and `WITH CHECK` behavior;
- permissive-policy composition;
- default privileges and schema-level findings;
- deterministic ordering; and
- clean summaries.

Imports must point to `src/audits/database/rls` and tests must not connect to a
database.

**Step 2: Run the analyzer test and verify RED**

Run:

```bash
npx vitest run test/unit/audits/database/rls/analyzer.test.ts
```

Expected: FAIL because the internal analyzer does not exist.

**Step 3: Migrate types and analyzer implementation**

Move the domain types and pure analyzer behavior from RLS Doctor. Preserve its
existing PostgreSQL semantics first; do not refactor the algorithm while moving
it. Do not bring over RLS Doctor reporters or exit-code logic.

**Step 4: Run the analyzer test and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/rls/types.ts src/audits/database/rls/analyzer.ts test/unit/audits/database/rls/analyzer.test.ts
git commit -m "feat: add internal RLS analyzer"
```

### Task 3: Migrate the safe PostgreSQL catalog boundary

**Files:**
- Create: `src/audits/database/rls/catalog.ts`
- Create: `src/audits/database/rls/redaction.ts`
- Create: `test/unit/audits/database/rls/catalog.test.ts`
- Create: `test/unit/audits/database/rls/redaction.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write failing catalog and redaction tests**

Port RLS Doctor's mapping tests for tables, policies, privileges, roles,
memberships, PostgreSQL 15/16 membership semantics, and relevant role topology.
Port credential-error tests covering raw, encoded, decoded, repeated, and
unresolved PostgreSQL URL forms.

Add a loader seam test using an injected client factory and assert that it:

```ts
expect(statements[0]).toMatch(/repeatable read read only/i);
expect(statements.at(-1)).toMatch(/commit/i);
```

**Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/audits/database/rls/catalog.test.ts test/unit/audits/database/rls/redaction.test.ts
```

Expected: FAIL because the loader and sanitizer do not exist.

**Step 3: Add dependencies and migrate the implementation**

Install `pg` as a runtime dependency and `@types/pg` as a development
dependency. Migrate the catalog queries and mapping functions. Keep the
transaction read-only and keep `application_name` set to `codebase-doctor`.

Expose a small client-factory seam so unit tests do not require Postgres. Ensure
rollback is attempted after a query failure and `end()` always runs.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add package.json package-lock.json src/audits/database/rls/catalog.ts src/audits/database/rls/redaction.ts test/unit/audits/database/rls/catalog.test.ts test/unit/audits/database/rls/redaction.test.ts
git commit -m "feat: add read-only PostgreSQL catalog loader"
```

### Task 4: Normalize RLS findings into Codebase Doctor findings

**Files:**
- Create: `src/audits/database/rls/mapper.ts`
- Create: `test/unit/audits/database/rls/mapper.test.ts`

**Step 1: Write failing mapping tests**

Create table-level and schema-level RLS findings and assert mappings such as:

```ts
expect(mapped).toMatchObject({
  ruleId: "database/rls/public-unconditional-write",
  doctorId: "database/rls",
  severity: "critical",
  confidence: "high",
  category: "database-security",
  evidence: [
    expect.objectContaining({
      type: "database",
      schema: "public",
      table: "documents",
    }),
  ],
});
```

Also assert that suggested SQL is included in remediation, credentials are
absent, schema-level findings have no table, and identical logical findings
produce identical fingerprints across generated timestamps and input ordering.

**Step 2: Run the mapper test and verify RED**

Run:

```bash
npx vitest run test/unit/audits/database/rls/mapper.test.ts
```

Expected: FAIL because `mapper.ts` does not exist.

**Step 3: Implement the minimal mapper**

Prefix every analyzer ID with `database/rls/`. Use `createFingerprint` with a
stable identity containing scope and analyzer ID, never timestamps or
connection information. Preserve analyzer title, detail, recommendation, and
suggested SQL.

**Step 4: Run the mapper test and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/audits/database/rls/mapper.ts test/unit/audits/database/rls/mapper.test.ts
git commit -m "feat: normalize RLS audit findings"
```

### Task 5: Add independent database capability permission

**Files:**
- Modify: `src/core/capabilities.ts`
- Modify: `test/unit/core/registry.test.ts`
- Create: `src/audits/database/rls/doctor.ts`
- Create: `test/unit/audits/database/rls/doctor.test.ts`

**Step 1: Write failing capability and doctor tests**

Extend capability tests so `network:access` is allowed only when
`withDatabase: true`, independently of `runChecks`.

Test the RLS doctor with an injected catalog loader:

- skipped by the registry without database permission;
- completed with normalized findings when permission and credentials exist;
- failed through the registry when credentials are missing;
- failed with a sanitized message when the loader exposes connection details;
- receives schemas and statement timeout from its options.

**Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/unit/core/registry.test.ts test/unit/audits/database/rls/doctor.test.ts
```

Expected: FAIL because database capability options and the doctor do not exist.

**Step 3: Implement permission and doctor adapter**

Change the capability options to:

```ts
export interface CapabilityOptions {
  runChecks: boolean;
  withDatabase?: boolean;
}
```

Grant `network:access` only for `withDatabase`. Build `createRlsDoctor` as a
closure over schemas, timeout, environment, and injected loader. Declare only
`network:access`; repository inventory is already available through context and
the loader does not need repository filesystem access.

**Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/capabilities.ts src/audits/database/rls/doctor.ts test/unit/core/registry.test.ts test/unit/audits/database/rls/doctor.test.ts
git commit -m "feat: add permissioned RLS doctor"
```

### Task 6: Register combined audits in the core scan pipeline

**Files:**
- Modify: `src/core/scan.ts`
- Modify: `test/unit/core/scan.test.ts`

**Step 1: Write failing core tests**

Add request fields:

```ts
withDatabase?: boolean;
databaseSchemas?: readonly string[];
databaseTimeoutMs?: number;
```

Assert that an audit request registers `database/rls`, passes independent
capability permission to the registry, and preserves the existing project and
check doctors. Assert that an ordinary scan request remains repository-only.

**Step 2: Run the core scan test and verify RED**

Run:

```bash
npx vitest run test/unit/core/scan.test.ts
```

Expected: FAIL because the request and default registry do not support RLS.

**Step 3: Implement minimal core registration**

Register the RLS doctor only for the combined audit path or through an explicit
request field that defaults false. Pass `withDatabase` into `runDoctors` and
preserve all existing default behavior for callers that omit the new fields.

**Step 4: Run the core scan test and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/scan.ts test/unit/core/scan.test.ts
git commit -m "feat: register database audit pipeline"
```

### Task 7: Add the unified `audit` CLI command

**Files:**
- Create: `src/commands/audit.ts`
- Modify: `src/commands/scan.ts`
- Modify: `src/cli.ts`
- Modify: `test/integration/cli-scan.test.ts`
- Create: `test/integration/cli-audit.test.ts`

**Step 1: Write failing CLI integration tests**

Test that:

- `codebase-doctor audit . --json` emits the normal unified report with an RLS
  doctor run skipped for missing database permission;
- `--with-database` without either supported environment variable exits `2`
  with a missing-credential message;
- `--database-schema` is repeatable and deduplicated;
- invalid or empty schemas and invalid database timeouts exit `2`;
- no CLI option accepts a connection URL;
- `scan` output remains compatible and does not register the RLS doctor.

Use injected execution where necessary; integration tests must not connect to a
real database.

**Step 2: Run CLI tests and verify RED**

Run:

```bash
npx vitest run test/integration/cli-audit.test.ts test/integration/cli-scan.test.ts
```

Expected: FAIL because `audit` is unknown.

**Step 3: Implement the command without duplicating scan parsing**

Extract reusable scan option parsing/execution only as far as needed. Add:

```text
--with-database
--database-schema <schema>
--database-timeout <ms>
```

Keep `scan` repository-only. Default database schemas to `public` and timeout to
10,000 ms. Register `audit` in `createProgram`.

**Step 4: Run CLI tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/audit.ts src/commands/scan.ts src/cli.ts test/integration/cli-audit.test.ts test/integration/cli-scan.test.ts
git commit -m "feat: add unified audit command"
```

### Task 8: Export the unified programmatic contract

**Files:**
- Modify: `src/index.ts`
- Modify: `test/integration/package-report-output.test.ts`

**Step 1: Write a failing package export test**

Import the public scan/audit request types and database evidence type from the
package entry point. Do not export the internal catalog loader or connection
credentials as part of the first public API.

**Step 2: Run the package test and verify RED**

Run:

```bash
npx vitest run test/integration/package-report-output.test.ts
```

Expected: FAIL because the new public types are not exported.

**Step 3: Add minimal type exports**

Export the stable shared request/result/finding types needed by agents and CI.
Keep RLS analyzer internals private until their compatibility policy is defined.

**Step 4: Run the package test and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts test/integration/package-report-output.test.ts
git commit -m "feat: export unified audit contracts"
```

### Task 9: Update user and agent documentation

**Files:**
- Modify: `README.md`
- Modify: `.agents/skills/codebase-doctor/SKILL.md`
- Modify: `docs/architecture.md`
- Modify: `test/unit/skill-contract.test.ts`

**Step 1: Write failing documentation contract tests**

Require the packaged skill to teach agents:

- start with `codebase-doctor audit . --json`;
- treat database coverage as skipped unless explicitly enabled;
- request permission before `--with-database`;
- use environment credentials and never print them;
- distinguish database operational failure from a clean audit; and
- use `scan` only for the backward-compatible repository-only path.

**Step 2: Run the skill test and verify RED**

Run:

```bash
npx vitest run test/unit/skill-contract.test.ts
```

Expected: FAIL because the current skill teaches only `scan`.

**Step 3: Update documentation**

Replace planned-command wording in the README with shipped behavior only after
the CLI works. Update architecture language that still mentions external
doctors. Document the permission boundary and safe examples without sample
secrets.

**Step 4: Run the skill test and verify GREEN**

Run the command from Step 2. Expected: PASS.

**Step 5: Commit**

```bash
git add README.md .agents/skills/codebase-doctor/SKILL.md docs/architecture.md test/unit/skill-contract.test.ts
git commit -m "docs: document unified database auditing"
```

### Task 10: Verify package and disposable database integration

**Files:**
- Create: `scripts/run-rls-integration.mjs`
- Create: `test/fixtures/rls/unsafe-schema.sql`
- Create: `test/fixtures/rls/safe-schema.sql`
- Modify: `package.json`
- Modify: `docs/release-checklist.md`

**Step 1: Add the opt-in Docker integration harness**

Adapt RLS Doctor's disposable-container strategy. Require an explicit destructive
test guard, generate a unique temporary database/container name, use low-
privilege audit credentials, and clean up in `finally`.

**Step 2: Run normal CI**

Run:

```bash
npm run ci
```

Expected: PASS.

**Step 3: Run package verification**

Run:

```bash
npm run test:package
```

Expected: PASS with a clean tarball installation and working `audit --help`.

**Step 4: Run the disposable Postgres integration when Docker is available**

Run:

```bash
CODEBASE_DOCTOR_ALLOW_DESTRUCTIVE_TESTS=1 npm run test:rls-integration
```

Expected: the unsafe schema produces namespaced findings, the safe schema has no
high-threshold findings, no credential is printed, and the container is removed.
If Docker is unavailable, record the integration as not run rather than claiming
it passed.

**Step 5: Run Codebase Doctor against itself**

Run read-only discovery first:

```bash
node dist/cli.js audit . --json
```

Review planned checks and doctor coverage. Then run configured checks only
because this repository is trusted and the implementation task authorizes its
normal verification commands:

```bash
node dist/cli.js audit . --run-checks --json
```

Expected: all requested doctors complete or explicitly skip, with no operational
failure and no finding at the configured threshold.

**Step 6: Commit**

```bash
git add scripts/run-rls-integration.mjs test/fixtures/rls package.json package-lock.json docs/release-checklist.md
git commit -m "test: verify unified RLS auditing"
```

### Task 11: Final regression and release-readiness check

**Files:**
- Modify only files required by failures found during verification.

**Step 1: Run the complete local suite**

```bash
npm run ci:full
```

Expected: typecheck, unit/integration tests, build, package checks, and dependency
audit all PASS.

**Step 2: Inspect the final diff and repository state**

```bash
git diff --check
git status --short
git log --oneline -15
```

Expected: no whitespace errors, no unintended files, and focused commits that
match the tasks above.

**Step 3: Record any environment-limited verification honestly**

If disposable Postgres integration could not run, report that separately from
the passing local and package suite. Do not publish or bump the package version
as part of this plan.
