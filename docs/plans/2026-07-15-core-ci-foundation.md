# Core CI Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe plan preview, configurable exclusions, baseline comparison, and deterministic SARIF output without breaking JSON schema version 1.

**Architecture:** Extend the existing scan pipeline with configuration loading before inventory, pure command planning before capability-gated execution, and optional fingerprint comparison after normalization. Keep the canonical `ScanResult` reporter-neutral, then render it as text, JSON, or SARIF.

**Tech Stack:** Node.js 20+, TypeScript, Commander, Vitest, tsup, npm.

---

### Task 1: Configuration and exclusion matching

**Files:**
- Create: `src/config/config.ts`
- Modify: `src/workspace/types.ts`
- Modify: `src/workspace/file-inventory.ts`
- Test: `test/unit/config/config.test.ts`
- Test: `test/unit/workspace/file-inventory.test.ts`

**Step 1: Write failing configuration tests**

Cover an absent config, a valid `{ "exclude": [...] }` config, malformed JSON,
unknown keys, non-string entries, absolute paths, and `..` traversal. Assert that
configuration errors use a dedicated `CodebaseConfigError`.

**Step 2: Run the configuration tests**

Run: `npx vitest run test/unit/config/config.test.ts`

Expected: FAIL because `src/config/config.ts` does not exist.

**Step 3: Implement the configuration contract**

Export:

```ts
export interface CodebaseConfig { exclude: readonly string[] }
export class CodebaseConfigError extends Error {}
export async function loadCodebaseConfig(root: string): Promise<CodebaseConfig>
export function validateExcludePattern(pattern: string): string
```

Read only `<root>/.codebase-doctor.json`; treat `ENOENT` as `{ exclude: [] }` and
reject all malformed contracts with a path-specific message.

**Step 4: Write failing inventory exclusion tests**

Assert exact files, exact directories, `*`, `?`, and `**` patterns. Prove excluded
directories are not traversed and paths remain repository-relative POSIX paths.

**Step 5: Implement exclusion matching**

Add `exclude?: readonly string[]` to `FileInventoryOptions`. Compile validated
patterns to anchored regular expressions. Test both `path` and `${path}/` before
adding a file or descending into a directory. Preserve all built-in exclusions.

**Step 6: Run focused tests and commit**

Run: `npx vitest run test/unit/config test/unit/workspace/file-inventory.test.ts`

Expected: PASS.

Commit: `feat: add configurable scan exclusions`

### Task 2: Deterministic read-only command planning

**Files:**
- Modify: `src/execution/types.ts`
- Create: `src/doctors/checks/planner.ts`
- Modify: `src/doctors/checks/doctor.ts`
- Modify: `src/core/normalize.ts`
- Modify: `src/core/scan.ts`
- Modify: `src/reporters/text.ts`
- Test: `test/unit/doctors/check-planning.test.ts`
- Test: `test/unit/core/scan.test.ts`
- Test: `test/unit/reporters/text.test.ts`

**Step 1: Write failing planner and scan tests**

Assert that one pure `planChecks(snapshot, timeoutMs)` call returns JavaScript and
Python plans in stable adapter and tool order. Assert a read-only scan exposes plans while the
Check Doctor remains skipped and no runner is invoked.

**Step 2: Run focused tests**

Run: `npx vitest run test/unit/doctors/check-planning.test.ts test/unit/core/scan.test.ts`

Expected: FAIL because scan results do not contain plans.

**Step 3: Extract planning and add public plan records**

Add:

```ts
export interface PlannedCheckRecord {
  planId: string;
  projectId: string;
  label: string;
  command: string;
}
```

`planner.ts` combines existing ecosystem planners while preserving each adapter's
intentional tool order. The scan
pipeline computes plans after project detection. `ScanResult.plannedChecks` is an
additive schema-1 field populated by normalization.

**Step 4: Execute the same plans**

Change `createCheckDoctor` to receive immutable precomputed plans. Do not plan
again inside `diagnose`. Keep `process:execute` gating and sequential execution.

**Step 5: Add text rendering tests and implementation**

Render a `Planned checks` section before doctor runs. Empty plans render `No
supported checks detected.` Do not emit live duplicate `Planned command` hooks.

**Step 6: Run focused tests and commit**

Run: `npx vitest run test/unit/doctors test/unit/core/scan.test.ts test/unit/reporters`

Expected: PASS.

Commit: `feat: preview planned checks without execution`

### Task 3: CLI configuration and output format contracts

**Files:**
- Modify: `src/commands/scan.ts`
- Modify: `src/core/scan.ts`
- Test: `test/integration/cli-scan.test.ts`
- Test: `test/unit/skill-contract.test.ts`

**Step 1: Write failing CLI tests**

Cover repeatable `--exclude`, config plus CLI merging, `--format text|json|sarif`,
the `--json` alias, invalid formats, and the conflict between `--json` and a
non-JSON explicit format.

**Step 2: Run CLI integration tests**

Run: `npx vitest run test/integration/cli-scan.test.ts`

Expected: FAIL because the options are unknown.

**Step 3: Implement option parsing**

Extend `ScanCommandOptions` and use a Commander collection parser for repeatable
exclusions. Resolve format with `--json` as an alias. Load configuration before
calling `scanCodebase`, merge config and CLI exclusions, and pass them into
inventory options.

**Step 4: Preserve operational errors**

All option, configuration, and pattern errors must be caught by `executeScan`,
written to stderr, and classified as exit `2` without partial stdout.

**Step 5: Run tests and commit**

Run: `npx vitest run test/integration/cli-scan.test.ts test/unit/skill-contract.test.ts`

Expected: PASS.

Commit: `feat: configure scan format and exclusions`

### Task 4: Baseline loading and fingerprint comparison

**Files:**
- Create: `src/core/baseline.ts`
- Modify: `src/core/normalize.ts`
- Modify: `src/commands/scan.ts`
- Modify: `src/reporters/text.ts`
- Test: `test/unit/core/baseline.test.ts`
- Test: `test/unit/core/normalize.test.ts`
- Test: `test/unit/reporters/text.test.ts`
- Test: `test/integration/cli-scan.test.ts`

**Step 1: Write failing pure comparison tests**

Use findings with stable fingerprints to assert sorted `new`, `unchanged`, and
`resolved` fingerprint arrays and a summary of new findings.

**Step 2: Run the baseline unit tests**

Run: `npx vitest run test/unit/core/baseline.test.ts`

Expected: FAIL because the module does not exist.

**Step 3: Implement baseline validation and comparison**

Export:

```ts
export interface FindingComparison {
  new: readonly string[];
  unchanged: readonly string[];
  resolved: readonly string[];
  newSummary: FindingSummary;
}
export async function loadBaseline(path: string): Promise<BaselineReport>
export function compareFindings(current: readonly Finding[], baseline: readonly Finding[]): FindingComparison
```

Validate tool name, schema version `1`, the findings array, severity, and non-empty
fingerprints. Reject unreadable or incompatible reports with `BaselineError`.

**Step 4: Attach comparison and change threshold input**

Add optional `comparison` to `ScanResult`. When present,
`classifyScanExit` selects current findings whose fingerprints occur in
`comparison.new`; doctor operational failures still take precedence as exit `2`.

**Step 5: Wire `--baseline` and text output**

Load the baseline before scanning, pass its findings into normalization, and add a
compact comparison section to text output. JSON serialization remains automatic.

**Step 6: Run focused tests and commit**

Run: `npx vitest run test/unit/core test/unit/reporters test/integration/cli-scan.test.ts`

Expected: PASS.

Commit: `feat: compare scans with a baseline`

### Task 5: Deterministic SARIF 2.1.0 reporter

**Files:**
- Create: `src/reporters/sarif.ts`
- Modify: `src/commands/scan.ts`
- Test: `test/unit/reporters/sarif.test.ts`
- Test: `test/integration/cli-scan.test.ts`

**Step 1: Write failing SARIF tests**

Assert SARIF version/schema, one driver, unique sorted rule descriptors, severity
mapping, messages, URI locations, fingerprints, evidence properties, remediation,
and `new|unchanged` baseline state.

**Step 2: Run the SARIF unit test**

Run: `npx vitest run test/unit/reporters/sarif.test.ts`

Expected: FAIL because the reporter does not exist.

**Step 3: Implement the reporter**

Map `critical|high` to SARIF `error`, `medium` to `warning`, and `low|info` to
`note`. Emit `partialFingerprints.codebaseDoctorFingerprint`. Convert repository-
relative locations to forward-slash artifact URIs. Store structured evidence and
confidence/category in result properties.

**Step 4: Wire the selected reporter**

Select text, JSON, or SARIF only after the single scan has completed. SARIF uses
the same threshold and operational-exit classification as every other reporter.

**Step 5: Run focused tests and commit**

Run: `npx vitest run test/unit/reporters test/integration/cli-scan.test.ts`

Expected: PASS.

Commit: `feat: report findings as SARIF`

### Task 6: Documentation, compatibility, and full verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `.agents/skills/codebase-doctor/SKILL.md`
- Modify: `test/unit/skill-contract.test.ts`
- Modify: `docs/architecture.md`

**Step 1: Update public documentation**

Document configuration, plan preview, baseline creation/comparison, SARIF usage,
and unchanged execution-consent rules. Mark GitHub Action packaging and doctor
packs as roadmap work.

**Step 2: Run contract and complete CI checks**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `npm run test:package`

Run: `npm audit --audit-level=high`

Expected: all project checks pass; an existing low-severity development-only
advisory may remain below the configured audit threshold.

**Step 3: Verify behavior manually**

Run: `node dist/cli.js scan . --json`

Expected: exit `0`, schema version `1`, and non-empty `plannedChecks` without
executing commands.

Run: `node dist/cli.js scan . --exclude 'test/fixtures/**' --run-checks --format sarif`

Expected: SARIF 2.1.0 output and no intentional fixture failure.

Run a baseline comparison against a temporary prior JSON report and verify only
new findings affect the threshold.

**Step 4: Confirm repository hygiene and commit**

Run: `git diff --check && git status --short`

Commit: `docs: document core CI foundation`
