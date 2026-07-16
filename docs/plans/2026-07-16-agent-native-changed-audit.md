# Agent-Native Changed Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe Git-aware changed auditing, affected-project selection, explicit audit-scope reporting, and model-oriented finding guidance without granting Codebase Doctor target-write authority.

**Architecture:** A read-only Git adapter produces normalized change records, and a pure scope planner maps those records to detected projects and reverse workspace dependants. The existing scan pipeline keeps a full read-only snapshot for context while checks and static SQL streams consume the explicit scope; reports add backward-compatible schema-1 scope and finding-guidance fields.

**Tech Stack:** TypeScript, Node.js `execFile`, Commander, Vitest, tsup, Git CLI, JSON, SARIF 2.1.0.

---

### Task 1: Define and parse the read-only Git change contract

**Files:**
- Create: `src/scope/types.ts`
- Create: `src/scope/git.ts`
- Test: `test/unit/scope/git.test.ts`

**Step 1: Write the failing parser tests**

Cover NUL-delimited Git name-status output for modifications, additions,
deletions, renames, and copies. Include spaces in paths and reject malformed
rename records. Assert deterministic POSIX paths and ordering.

```ts
expect(parseNameStatus("M\0src/a.ts\0R100\0old.ts\0new.ts\0")).toEqual([
  { status: "modified", path: "src/a.ts" },
  { status: "renamed", path: "new.ts", previousPath: "old.ts" },
]);
```

Also test reduction of staged and unstaged views so the same path appears once,
and ensure a deletion or rename is not weakened into a modification.

**Step 2: Run the tests and verify they fail**

Run:

```bash
npx vitest run test/unit/scope/git.test.ts
```

Expected: FAIL because `src/scope/git.ts` and its exported functions do not
exist.

**Step 3: Add the scope types**

Define immutable public types:

```ts
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

export interface ChangedPath {
  status: ChangeStatus;
  path: string;
  previousPath?: string;
}

export interface AuditBase {
  kind: "head" | "merge-base";
  requestedRef: string | null;
  resolvedCommit: string;
}

export interface ScopeReason {
  projectId: string;
  reason: "direct-change" | "workspace-dependent" | "root-context";
  source: string;
}

export interface AuditScope {
  mode: "full" | "changed";
  base: AuditBase | null;
  changes: readonly ChangedPath[];
  affectedProjectIds: readonly string[];
  reasons: readonly ScopeReason[];
  limitations: readonly string[];
}
```

**Step 4: Implement the pure parser and reducer**

Implement and export:

```ts
export function parseNameStatus(output: string): ChangedPath[];
export function parseUntracked(output: string): ChangedPath[];
export function mergeChangedPaths(...views: readonly ChangedPath[][]): ChangedPath[];
```

Normalize backslashes, reject absolute or parent-escaping paths, preserve old
rename/copy paths, and sort by `path`, `previousPath`, then `status`.

**Step 5: Run the focused tests**

Run:

```bash
npx vitest run test/unit/scope/git.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/scope/types.ts src/scope/git.ts test/unit/scope/git.test.ts
git commit -m "feat: define Git change discovery contract"
```

### Task 2: Discover local and branch changes without mutating Git state

**Files:**
- Modify: `src/scope/git.ts`
- Modify: `test/unit/scope/git.test.ts`
- Modify: `test/helpers/temp-project.ts`
- Create: `test/integration/changed-scope-git.test.ts`

**Step 1: Write failing Git integration tests**

Add helpers that initialize disposable repositories using fixed argument arrays,
set local test identity, write an initial commit, and return status snapshots.
Test:

- unstaged and staged modifications;
- untracked files;
- deletions and renames;
- `HEAD` as the default resolved base;
- an explicit branch ref resolving through `git merge-base`;
- invalid refs and non-Git roots;
- identical `git status --porcelain=v1 -z` before and after discovery.

**Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run test/integration/changed-scope-git.test.ts
```

Expected: FAIL because repository discovery has not been implemented.

**Step 3: Implement a fixed-argument Git runner**

Use `execFile`, never a shell string. Make the runner injectable in unit tests:

```ts
export interface GitRunner {
  run(root: string, args: readonly string[]): Promise<string>;
}

export interface DiscoverChangesOptions {
  root: string;
  baseRef?: string;
}

export interface DiscoveredChanges {
  base: AuditBase;
  changes: readonly ChangedPath[];
}

export async function discoverGitChanges(
  options: DiscoverChangesOptions,
  runner?: GitRunner,
): Promise<DiscoveredChanges>;
```

The command sequence is read-only:

- verify `rev-parse --show-toplevel` matches the requested repository root;
- resolve `HEAD^{commit}` for local mode;
- resolve `merge-base <baseRef> HEAD` for explicit base mode;
- collect `diff --name-status -z --find-renames --find-copies <resolvedBase>`;
- collect `ls-files --others --exclude-standard -z`;
- parse and merge both views.

Wrap failures in `GitScopeError` with stable operational codes and redacted,
concise messages. Do not expose arbitrary Git stderr in reports.

**Step 4: Run unit and integration tests**

Run:

```bash
npx vitest run test/unit/scope/git.test.ts test/integration/changed-scope-git.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/scope/git.ts test/unit/scope/git.test.ts test/integration/changed-scope-git.test.ts test/helpers/temp-project.ts
git commit -m "feat: discover changed paths read-only"
```

### Task 3: Plan directly affected projects and reverse workspace dependants

**Files:**
- Create: `src/scope/planner.ts`
- Test: `test/unit/scope/planner.test.ts`
- Modify: `src/workspace/types.ts`
- Modify: `src/workspace/project-detector.ts`
- Modify: `test/unit/workspace/project-detector.test.ts`

**Step 1: Write failing project-metadata and scope tests**

Extend detected Node projects with optional package identity and declared
dependency names:

```ts
expect(web).toMatchObject({
  packageName: "@example/web",
  dependencyNames: ["@example/ui", "react"],
});
```

Then test that:

- a path belongs to the deepest containing project;
- a root configuration file affects all projects;
- changing `packages/ui` affects `apps/web` when web depends on UI;
- dependency closure is transitive and cycle-safe;
- unknown or invalid package metadata adds a limitation rather than inventing
  an edge;
- output and reasons are deterministic.

**Step 2: Run the tests and verify failure**

Run:

```bash
npx vitest run test/unit/workspace/project-detector.test.ts test/unit/scope/planner.test.ts
```

Expected: FAIL because package dependency metadata and scope planning are
missing.

**Step 3: Add backward-compatible detected-project metadata**

Add optional fields to `DetectedProject`:

```ts
packageName?: string;
dependencyNames?: readonly string[];
```

Read string keys from `dependencies`, `devDependencies`, `peerDependencies`,
and `optionalDependencies`. Sort and deduplicate them. Invalid manifests do not
produce metadata.

**Step 4: Implement the pure scope planner**

```ts
export function planChangedScope(
  base: AuditBase,
  changes: readonly ChangedPath[],
  projects: readonly DetectedProject[],
): AuditScope;

export function fullAuditScope(): AuditScope;
```

Use deepest-root ownership. Treat repository-level manifests, lockfiles,
workspace configuration, TypeScript base configuration, and Codebase Doctor
configuration as root-context signals. Compute reverse dependency closure only
for unambiguous package names.

**Step 5: Run the focused tests**

Run:

```bash
npx vitest run test/unit/workspace/project-detector.test.ts test/unit/scope/planner.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/scope/planner.ts test/unit/scope/planner.test.ts src/workspace/types.ts src/workspace/project-detector.ts test/unit/workspace/project-detector.test.ts
git commit -m "feat: plan affected workspace scope"
```

### Task 4: Thread audit scope through the scan core and select checks

**Files:**
- Modify: `src/core/scan.ts`
- Modify: `src/core/normalize.ts`
- Modify: `src/workspace/types.ts`
- Modify: `src/doctors/checks/planner.ts`
- Modify: `test/unit/core/scan.test.ts`
- Modify: `test/unit/core/normalize.test.ts`
- Modify: `test/unit/doctors/check-planning.test.ts`

**Step 1: Write failing scan and check-selection tests**

Assert that:

- every full audit emits `auditScope.mode === "full"`;
- changed requests call the injected Git discovery dependency;
- `ProjectSnapshot.auditScope` is available to doctors;
- only affected projects receive command plans in changed mode;
- full mode still plans all existing checks;
- an empty changed scope plans no checks;
- full-context project diagnostics still run in changed mode.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run test/unit/core/scan.test.ts test/unit/core/normalize.test.ts test/unit/doctors/check-planning.test.ts
```

Expected: FAIL because scope is not part of requests, snapshots, or reports.

**Step 3: Extend requests and dependencies**

Add:

```ts
interface ScanRequest {
  changed?: boolean;
  baseRef?: string;
}

interface ScanDependencies {
  discoverChanges(options: DiscoverChangesOptions): Promise<DiscoveredChanges>;
}
```

After project detection, derive `fullAuditScope()` or `planChangedScope(...)`.
Store it on `ProjectSnapshot` and pass it to result normalization.

**Step 4: Select affected check plans**

Change `planChecks` to filter by `snapshot.auditScope.affectedProjectIds` only
when mode is `changed`. Keep the existing language-specific planners unchanged
where possible by passing a snapshot whose projects are selected but whose
files and manifests remain full read-only context.

**Step 5: Add scope to schema-1 results**

Add required `auditScope: AuditScope` to `ScanResult`. Update existing unit-test
fixtures and constructors with `fullAuditScope()`. Keep all existing fields and
meanings.

**Step 6: Run focused and regression tests**

Run:

```bash
npx vitest run test/unit/core test/unit/doctors/check-planning.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/core/scan.ts src/core/normalize.ts src/workspace/types.ts src/doctors/checks/planner.ts test/unit/core test/unit/doctors/check-planning.test.ts
git commit -m "feat: apply affected scope to repository checks"
```

### Task 5: Scope static SQL auditing without losing migration history

**Files:**
- Modify: `src/audits/database/sql-rls/discovery.ts`
- Modify: `src/audits/database/sql-rls/doctor.ts`
- Modify: `test/unit/audits/database/sql-rls/discovery.test.ts`
- Modify: `test/unit/audits/database/sql-rls/doctor.test.ts`

**Step 1: Write failing stream-selection tests**

Test that:

- changing one migration selects its containing stream;
- every file in the selected stream is still read and reduced in order;
- a deleted or renamed old migration path selects the former stream root;
- unrelated streams are not selected;
- full mode selects every discovered stream;
- no selected stream produces explicit not-selected coverage rather than a
  global clean claim.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run test/unit/audits/database/sql-rls/discovery.test.ts test/unit/audits/database/sql-rls/doctor.test.ts
```

Expected: FAIL because stream discovery ignores audit scope.

**Step 3: Add pure stream selection**

Implement:

```ts
export function selectSqlStreams(
  streams: readonly SqlMigrationStream[],
  scope: AuditScope,
): SqlMigrationStream[];
```

Match both `change.path` and `change.previousPath` against stream roots. For a
deleted stream whose current inventory has no remaining files, emit partial
coverage explaining that historical state cannot be reconstructed from the
current worktree.

**Step 4: Update doctor coverage**

Analyze the complete contents of selected streams. Add an explicit limitation
to changed coverage stating that unselected streams were outside affected
scope. Do not change live RLS permission behavior.

**Step 5: Run focused tests**

Run:

```bash
npx vitest run test/unit/audits/database/sql-rls
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/audits/database/sql-rls/discovery.ts src/audits/database/sql-rls/doctor.ts test/unit/audits/database/sql-rls
git commit -m "feat: audit affected SQL migration streams"
```

### Task 6: Expose and validate `--changed` and `--base`

**Files:**
- Modify: `src/commands/scan.ts`
- Modify: `src/commands/audit.ts`
- Modify: `test/integration/cli-scan.test.ts`
- Modify: `test/integration/cli-audit.test.ts`

**Step 1: Write failing CLI tests**

Use disposable Git repositories to assert:

- `audit . --changed --json` reports HEAD-based scope;
- `audit . --changed --base main --json` reports merge-base scope;
- `--base` without `--changed` exits `2` before any configured check runs;
- an invalid ref exits `2`;
- changed mode does not imply `--run-checks` or `--with-database`;
- `scan` receives the same repository-scope flags for compatibility;
- baseline comparison remains usable with changed mode.

**Step 2: Run integration tests and verify failure**

Run:

```bash
npx vitest run test/integration/cli-scan.test.ts test/integration/cli-audit.test.ts
```

Expected: FAIL with unknown options.

**Step 3: Add shared repository command options**

Extend `RepositoryCommandOptions` and `configureRepositoryCommand`:

```ts
.option("--changed", "audit staged, unstaged, untracked, and branch changes", false)
.option("--base <ref>", "compare changed scope from the merge base with this ref")
```

Validate `options.base !== undefined && !options.changed` before loading a
baseline or allowing checks. Map the options into `ScanRequest`.

**Step 4: Run integration tests**

Run:

```bash
npx vitest run test/integration/cli-scan.test.ts test/integration/cli-audit.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/scan.ts src/commands/audit.ts test/integration/cli-scan.test.ts test/integration/cli-audit.test.ts
git commit -m "feat: expose changed audit CLI"
```

### Task 7: Add model-oriented finding guidance and compact report evidence

**Files:**
- Modify: `src/core/findings.ts`
- Modify: `src/reporters/text.ts`
- Modify: `src/reporters/sarif.ts`
- Modify: `test/unit/core/findings.test.ts`
- Modify: `test/unit/reporters/json.test.ts`
- Modify: `test/unit/reporters/text.test.ts`
- Modify: `test/unit/reporters/sarif.test.ts`
- Modify: `src/doctors/project/rules/conflicting-lockfiles.ts`
- Modify: `src/doctors/project/rules/invalid-manifest.ts`
- Modify: `src/doctors/project/rules/missing-workspace.ts`
- Modify: `src/doctors/project/rules/test-visibility.ts`
- Modify: `src/doctors/checks/doctor.ts`
- Modify: `src/audits/database/sql-rls/analyzer.ts`
- Modify: `src/audits/database/rls/mapper.ts`

**Step 1: Write failing contract and reporter tests**

Assert preservation and deterministic rendering of:

```ts
impact?: string;
remediationConstraints?: readonly string[];
verification?: { command: string; expected: string };
```

Text should render Impact, Repair constraints, and Verification after evidence.
SARIF result properties should contain structured copies. JSON needs no custom
transformation but gets a regression assertion. Also assert `auditScope` is
rendered before findings in text and included in SARIF run properties.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run test/unit/core/findings.test.ts test/unit/reporters
```

Expected: FAIL because the optional fields and reporter output do not exist.

**Step 3: Add the additive finding fields**

Extend `Finding` without changing fingerprint input. Add a pure validation or
normalization helper only if necessary; never place remediation text in the
fingerprint.

**Step 4: Render structured guidance and scope**

Text prints concise fields. SARIF stores guidance in `properties` and uses
impact in rule help only when it does not displace existing remediation.
Include `auditScope` alongside coverage in SARIF run properties.

**Step 5: Populate every existing built-in rule**

Give each existing project, check, static SQL RLS, and live RLS mapping a
specific impact, invariant-style remediation constraint, and verification
instruction. Verification must always call Codebase Doctor and describe
expected absence of the fingerprint with completed applicable coverage. It
must never tell Codebase Doctor to apply a repair.

**Step 6: Run focused tests**

Run:

```bash
npx vitest run test/unit/core/findings.test.ts test/unit/reporters test/unit/doctors test/unit/audits/database
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/core/findings.ts src/reporters test/unit/core/findings.test.ts test/unit/reporters src/doctors src/audits/database
git commit -m "feat: add model-oriented finding guidance"
```

### Task 8: Export the public contract and document agent usage

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `.agents/skills/codebase-doctor/SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `test/unit/skill-contract.test.ts`
- Modify: `test/unit/product-boundary-contract.test.ts`
- Modify: `test/integration/package-report-output.test.ts`
- Modify: `test/integration/packed-cli.test.ts`

**Step 1: Write failing package and documentation contract tests**

Assert that the packed package exports the audit-scope types and supports
`--changed`. Extend product-boundary tests to reject language implying that
changed auditing fixes, applies, rewrites, or mutates target code. Assert the
skill teaches agents to inspect scope and coverage before treating findings as
resolved.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts test/integration/packed-cli.test.ts test/integration/package-report-output.test.ts
```

Expected: FAIL until exports, docs, and packed behavior are updated.

**Step 3: Export the scope contract**

Export `AuditScope`, `AuditBase`, `ChangedPath`, `ChangeStatus`, `ScopeReason`,
`GitScopeError`, `discoverGitChanges`, `planChangedScope`, and
`fullAuditScope` where appropriate. Keep internal runner injection private if
it is not useful to consumers.

**Step 4: Update product documentation**

Document:

```bash
codebase-doctor audit . --changed --json
codebase-doctor audit . --changed --base main --json
```

Explain affected scope, full-context doctors, explicit limitations, exit `2`
for scope failures, orthogonal baselines, and the unchanged permissions for
checks and live databases. Describe the finding guidance as instructions for a
separately authorized repair actor.

Add the feature under unreleased `0.1.3`; do not bump the package version or
publish during this task.

**Step 5: Run documentation and package tests**

Run:

```bash
npx vitest run test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts
npm run test:package
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/index.ts README.md docs/architecture.md .agents/skills/codebase-doctor/SKILL.md CHANGELOG.md test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts test/integration/package-report-output.test.ts test/integration/packed-cli.test.ts
git commit -m "docs: teach agents changed-audit workflow"
```

### Task 9: Verify the complete auditor boundary and release candidate

**Files:**
- Modify only if verification exposes a defect in files already in scope.

**Step 1: Run formatting and static checks**

Run:

```bash
git diff --check
npm run typecheck
```

Expected: PASS.

**Step 2: Run the source suite and build**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

**Step 3: Run package and live RLS regression suites**

Run:

```bash
npm run test:package
npm run test:rls-integration
npm audit --audit-level=high
```

Expected: PASS, with zero high-or-higher dependency vulnerabilities. If the
local PostgreSQL integration prerequisite is unavailable, report that exact
limitation instead of claiming it passed.

**Step 4: Prove changed auditing is observational**

Record hashes and Git status of a disposable target, run changed audits in
text, JSON, and SARIF modes without `--run-checks`, then compare hashes and Git
status. Expected: byte-for-byte target equality and unchanged Git state.

Also run Codebase Doctor against itself:

```bash
node dist/cli.js audit . --exclude 'test/fixtures/**' --json --fail-on none
node dist/cli.js audit . --changed --json --fail-on none
```

Inspect `auditScope`, every `doctorRuns` entry, and coverage; zero findings do
not override partial or skipped coverage.

**Step 5: Review final diff and commit any verification-only correction**

Run:

```bash
git diff --check
git status --short
git log --oneline -15
```

If verification required a correction, commit only that correction:

```bash
git add <corrected-files>
git commit -m "fix: harden changed audit verification"
```

Expected: clean worktree after the final commit. Do not push, tag, publish, or
create a release without a separate explicit request.
