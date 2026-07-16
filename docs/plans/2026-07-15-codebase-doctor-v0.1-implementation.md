# Codebase Doctor v0.1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and package a safe, deterministic `codebase-doctor@0.1.0` CLI with repository discovery, JavaScript/TypeScript and Python validation planning, explicit check execution, normalized text/JSON findings, and a minimal agent skill.

**Architecture:** A single TypeScript npm package converts CLI input into a provider-neutral scan request. One workspace scan feeds capability-gated doctors; their results pass through a normalizer before independent text and JSON reporters render them. Static inspection is read-only, subprocess execution requires `--run-checks`, and model-specific integrations remain thin adapters over the CLI.

**Tech Stack:** Node.js 20+, TypeScript 7, Commander 15, Vitest 4, tsup 8, npm, GitHub Actions.

---

## Implementation Rules

- Follow test-driven development: write one failing test, observe the expected failure, implement the smallest behavior, and rerun.
- Use `node:fs`, `node:path`, `node:crypto`, and `node:child_process` before adding runtime dependencies.
- Do not run target-project subprocesses unless the validated scan request has `runChecks: true`.
- Do not follow filesystem symlinks during workspace discovery.
- Do not invoke a shell for planned validation commands.
- Do not install target-project dependencies.
- Keep the target repository unchanged in every test.
- Do not publish to npm during this plan. End with a verified tarball and request explicit release approval.
- Make one focused commit after each task passes its listed verification.

## Task 1: Scaffold the Publishable CLI

**Files:**

- Create: `package.json`
- Create: `package-lock.json` through `npm install`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `src/cli.ts`
- Create: `src/index.ts`
- Create: `test/integration/cli-version.test.ts`

**Step 1: Create package metadata and tool configuration**

Use this package shape:

```json
{
  "name": "codebase-doctor",
  "version": "0.1.0",
  "description": "A model-independent CLI for evidence-backed codebase diagnostics.",
  "type": "module",
  "bin": {
    "codebase-doctor": "dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "docs",
    ".agents/skills/codebase-doctor",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsup src/cli.ts src/index.ts --format esm --dts --clean",
    "dev": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "ci": "npm run typecheck && npm test && npm run build",
    "prepare": "npm run build"
  },
  "keywords": [
    "codebase",
    "diagnostics",
    "static-analysis",
    "testing",
    "developer-tools",
    "ai-agents",
    "cli"
  ],
  "author": "Subhajit Pradhan",
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "commander": "^15.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.19.43",
    "tsup": "^8.5.1",
    "tsx": "^4.23.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

Use `module: "ESNext"`, `moduleResolution: "Bundler"`, strict typing, declaration output, and Node 20 libraries in `tsconfig.json`. Ignore `node_modules`, `dist`, coverage, logs, and local environment files without ignoring test fixtures.

**Step 2: Install and lock dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is generated and `npm audit` does not report an unreviewed high or critical vulnerability.

**Step 3: Write the failing CLI version test**

The test should execute `tsx src/cli.ts --version` with `spawnSync`, then assert exit `0` and stdout `0.1.0`.

```ts
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI version", () => {
  it("prints the package version", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--version"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });
});
```

**Step 4: Run the test and observe failure**

Run:

```bash
npx vitest run test/integration/cli-version.test.ts
```

Expected: FAIL because `src/cli.ts` does not exist or does not register the version.

**Step 5: Implement the smallest CLI**

Create a Commander program named `codebase-doctor`, read the version from a single exported `VERSION = "0.1.0"` constant, and call `parseAsync()` only when `src/cli.ts` is the entrypoint. Include the `#!/usr/bin/env node` shebang in `src/cli.ts`.

**Step 6: Verify foundation**

Run:

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js --version
```

Expected: all commands pass and the built CLI prints `0.1.0`.

**Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore LICENSE src test
git commit -m "chore: scaffold codebase doctor cli"
```

## Task 2: Define Findings, Evidence, Fingerprints, and Summaries

**Files:**

- Create: `src/core/findings.ts`
- Create: `src/core/summary.ts`
- Modify: `src/index.ts`
- Create: `test/unit/core/findings.test.ts`
- Create: `test/unit/core/summary.test.ts`

**Step 1: Write failing finding tests**

Cover:

- stable fingerprint for identical logical inputs
- different fingerprint when rule, path, or evidence identity changes
- severity ordering: critical, high, medium, low, info
- deterministic ordering by severity, doctor ID, path, and rule ID
- summary counts and highest severity

Use a helper that constructs a complete finding so tests never rely on partial casts.

**Step 2: Observe failure**

```bash
npx vitest run test/unit/core
```

Expected: FAIL because the domain modules do not exist.

**Step 3: Implement the published domain types**

Define:

```ts
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = "low" | "medium" | "high";

export type Evidence =
  | { type: "file"; path: string; detail: string }
  | { type: "manifest"; path: string; detail: string }
  | { type: "command"; command: string; exitCode: number; output?: string }
  | { type: "observation"; detail: string };

export interface Finding {
  ruleId: string;
  doctorId: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  title: string;
  message: string;
  location?: { path: string; line?: number; column?: number };
  evidence: readonly Evidence[];
  remediation?: string;
  fingerprint: string;
}
```

Generate fingerprints with SHA-256 over a canonical JSON array containing doctor ID, rule ID, normalized location, and a rule-supplied identity string. Do not hash terminal formatting or full command output.

**Step 4: Implement summary behavior**

Return all five severity counts, total findings, and `highestSeverity: Severity | null`. Export pure functions from `src/index.ts`.

**Step 5: Verify and commit**

```bash
npx vitest run test/unit/core
npm run typecheck
git add src/core src/index.ts test/unit/core
git commit -m "feat: define diagnostic finding contract"
```

## Task 3: Build Safe Workspace Inventory

**Files:**

- Create: `src/workspace/types.ts`
- Create: `src/workspace/file-inventory.ts`
- Create: `test/helpers/temp-project.ts`
- Create: `test/unit/workspace/file-inventory.test.ts`

**Step 1: Write failing inventory tests**

Create disposable repositories with `mkdtemp`. Assert that inventory:

- returns POSIX-style relative paths in deterministic order
- skips `.git`, `node_modules`, `.next`, `dist`, `build`, `.venv`, `venv`, `target`, and cache directories
- does not follow a symlink to a directory inside or outside the scan root
- rejects a nonexistent root
- rejects a file when a directory root is required

Skip the symlink assertion only on a platform that explicitly denies symlink creation; do not weaken production behavior.

**Step 2: Observe failure**

```bash
npx vitest run test/unit/workspace/file-inventory.test.ts
```

**Step 3: Implement bounded traversal**

Use `lstat`, never `stat`, before deciding whether to descend. Return:

```ts
export interface FileRecord {
  path: string;
  kind: "file" | "symlink";
  size: number;
}

export interface FileInventory {
  root: string;
  files: readonly FileRecord[];
}
```

Add configurable limits with conservative defaults: maximum 100,000 files and maximum traversal depth 50. Exceeding a limit is an operational error, not a code finding.

**Step 4: Verify and commit**

```bash
npx vitest run test/unit/workspace/file-inventory.test.ts
npm run typecheck
git add src/workspace test/helpers test/unit/workspace
git commit -m "feat: add bounded workspace inventory"
```

## Task 4: Detect Projects, Manifests, Frameworks, and Workspaces

**Files:**

- Create: `src/workspace/manifest-loader.ts`
- Create: `src/workspace/project-detector.ts`
- Modify: `src/workspace/types.ts`
- Create: `test/unit/workspace/manifest-loader.test.ts`
- Create: `test/unit/workspace/project-detector.test.ts`

**Step 1: Write failing manifest tests**

Test valid and invalid `package.json`, unreadable JSON shape, and preservation of parse errors as structured manifest records rather than thrown scan-wide errors.

**Step 2: Write failing detection tests**

Test:

- Node project from `package.json`
- TypeScript from `tsconfig.json` or TypeScript dependency evidence
- Next.js, React, Vite, and NestJS from dependencies/devDependencies
- Python from `pyproject.toml`, `requirements.txt`, or `setup.cfg`
- npm, pnpm, Yarn, and Bun from lockfiles
- package workspaces using exact entries and one-level `directory/*` entries
- monorepo containing both Node and Python projects
- Go/Rust/Java detection as unsupported-for-execution metadata

**Step 3: Observe failure**

```bash
npx vitest run test/unit/workspace
```

**Step 4: Implement detection without executing code**

Use evidence records:

```ts
export interface DetectedProject {
  id: string;
  root: string;
  ecosystems: readonly string[];
  languages: readonly string[];
  frameworks: readonly string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  manifestPaths: readonly string[];
  executionSupport: "supported" | "detected-only";
}
```

Do not parse or execute JavaScript configuration files. Inspect dependency names and known static config filenames only. For Python `0.1.0`, treat `pyproject.toml` as text signals; do not claim full TOML validation without a parser.

**Step 5: Verify and commit**

```bash
npx vitest run test/unit/workspace
npm run typecheck
git add src/workspace test/unit/workspace
git commit -m "feat: detect repository project structure"
```

## Task 5: Implement the Doctor Registry and Capability Gate

**Files:**

- Create: `src/core/capabilities.ts`
- Create: `src/core/doctor.ts`
- Create: `src/core/registry.ts`
- Create: `test/unit/core/registry.test.ts`

**Step 1: Write failing capability tests**

Use fake doctors to assert:

- read-only doctors run during a default scan
- a `process:execute` doctor is skipped without execution permission
- no networked doctor can run without permission, and target-write authority is
  outside the Doctor capability contract
- one failed doctor returns an operational failure while later eligible doctors still run
- unsupported doctors return skipped status with a reason

**Step 2: Observe failure**

```bash
npx vitest run test/unit/core/registry.test.ts
```

**Step 3: Implement contracts**

Implement the `Doctor`, `DoctorContext`, `DoctorResult`, `Capability`, and `OperationalError` contracts from `docs/architecture.md`. Make allowed capabilities an explicit set built from the validated scan request.

Do not execute doctors concurrently in `0.1.0`; deterministic sequential execution makes logs and resource limits easier to audit.

**Step 4: Verify and commit**

```bash
npx vitest run test/unit/core/registry.test.ts
npm run typecheck
git add src/core test/unit/core/registry.test.ts
git commit -m "feat: add capability-gated doctor registry"
```

## Task 6: Implement Project Doctor Rules

**Files:**

- Create: `src/doctors/project/doctor.ts`
- Create: `src/doctors/project/rules/conflicting-lockfiles.ts`
- Create: `src/doctors/project/rules/invalid-manifest.ts`
- Create: `src/doctors/project/rules/missing-workspace.ts`
- Create: `src/doctors/project/rules/test-visibility.ts`
- Create: `test/unit/doctors/project-doctor.test.ts`

**Step 1: Write one failing test per rule**

Expected initial rules:

- `repository/conflicting-lockfiles`: medium, high confidence, only when competing manager lockfiles share one project boundary
- `repository/invalid-manifest`: high, high confidence, includes parse evidence
- `repository/missing-workspace`: medium, high confidence, for exact or supported one-level workspace patterns with no match
- `repository/no-visible-tests`: info, medium confidence, never a failing default threshold

Also assert that a pnpm workspace with package-level npm lockfiles does not become a false positive unless those lockfiles conflict within the same detected project.

**Step 2: Observe failure**

```bash
npx vitest run test/unit/doctors/project-doctor.test.ts
```

**Step 3: Implement pure rules and doctor composition**

Each rule accepts a `ProjectSnapshot` and returns findings. The doctor combines them without filesystem reads outside the snapshot. Use stable identity strings for fingerprints.

**Step 4: Verify and commit**

```bash
npx vitest run test/unit/doctors/project-doctor.test.ts
npm run typecheck
git add src/doctors/project test/unit/doctors/project-doctor.test.ts
git commit -m "feat: add cross-project diagnostics"
```

## Task 7: Plan JavaScript and Python Validation Commands

**Files:**

- Create: `src/execution/types.ts`
- Create: `src/execution/command-plan.ts`
- Create: `src/doctors/checks/javascript.ts`
- Create: `src/doctors/checks/python.ts`
- Create: `test/unit/execution/command-plan.test.ts`
- Create: `test/unit/doctors/check-planning.test.ts`

**Step 1: Write failing JavaScript planning tests**

Assert:

- package manager follows the lockfile evidence
- only existing scripts are planned
- order is typecheck/check, test, lint, build
- npm produces `npm run <script>` argument arrays
- pnpm produces `pnpm run <script>`
- Yarn and Bun use their explicit run forms
- install, prepare, preinstall, postinstall, arbitrary user input, and undeclared scripts are never planned

**Step 2: Write failing Python planning tests**

Assert:

- pytest is planned only with test/config evidence
- Ruff and mypy are planned only with static configuration evidence
- `uv.lock` prefers `uv run <tool>`
- `poetry.lock` prefers `poetry run <tool>`
- otherwise use `python -m pytest`, `ruff check .`, and `mypy .`
- command plans are argument arrays with explicit working directories

**Step 3: Observe failure**

```bash
npx vitest run test/unit/execution/command-plan.test.ts test/unit/doctors/check-planning.test.ts
```

**Step 4: Implement immutable command plans**

```ts
export interface CommandPlan {
  id: string;
  projectId: string;
  label: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}
```

Add a display helper that safely joins executable and quoted arguments for evidence. The display string must never be passed to a shell.

**Step 5: Verify and commit**

```bash
npx vitest run test/unit/execution test/unit/doctors/check-planning.test.ts
npm run typecheck
git add src/execution src/doctors/checks test/unit/execution test/unit/doctors/check-planning.test.ts
git commit -m "feat: plan configured validation checks"
```

## Task 8: Build the Bounded Subprocess Runner and Redaction

**Files:**

- Create: `src/execution/command-runner.ts`
- Create: `src/execution/redaction.ts`
- Create: `test/unit/execution/command-runner.test.ts`
- Create: `test/unit/execution/redaction.test.ts`

**Step 1: Write failing runner tests**

Use `process.execPath` with `-e` scripts to test:

- successful exit and captured output
- non-zero exit
- timeout and process termination
- stdout/stderr truncation at 64 KiB combined or separately documented limits
- executable-not-found result
- shell metacharacters remain literal arguments
- minimal environment contains `PATH`, platform necessities, `CI=1`, and `NO_COLOR=1` but excludes fixture secrets

**Step 2: Write failing redaction tests**

Cover:

- URL credentials
- `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, and API-key fixture values
- common bearer-token shapes in command output
- harmless paths and error messages remain readable

Do not promise perfect secret detection. Test known patterns and exact environment values removed from the child environment.

**Step 3: Observe failure**

```bash
npx vitest run test/unit/execution
```

**Step 4: Implement without a shell**

Use `spawn(executable, args, { shell: false, cwd, env, stdio: [...] })`. Return a discriminated result for completed, timed out, and failed-to-start commands. Kill timed-out processes, then settle once without double-resolution.

Document in code that the runner does not enforce network isolation in `0.1.0`.

**Step 5: Verify and commit**

```bash
npx vitest run test/unit/execution
npm run typecheck
git add src/execution test/unit/execution
git commit -m "feat: add bounded validation runner"
```

## Task 9: Implement Check Doctor

**Files:**

- Create: `src/doctors/checks/doctor.ts`
- Create: `test/unit/doctors/check-doctor.test.ts`

**Step 1: Write failing doctor tests**

Inject a fake command runner and assert:

- `supports` returns true for supported Node or Python projects
- a successful command creates no failure finding
- a non-zero command creates one `checks/command-failed` finding with command evidence
- a timeout creates `checks/command-timeout`
- missing executable produces a skipped check record, not a code finding
- output is redacted before it enters evidence
- the doctor never runs a command when execution capability is absent

**Step 2: Observe failure**

```bash
npx vitest run test/unit/doctors/check-doctor.test.ts
```

**Step 3: Implement sequential execution**

Build plans from the detected snapshot, run them sequentially, and return duration plus check-run metadata. Keep command failure severity high and timeout severity medium unless evidence shows a stronger defect; the test should lock the chosen policy.

**Step 4: Verify and commit**

```bash
npx vitest run test/unit/doctors/check-doctor.test.ts
npm run typecheck
git add src/doctors/checks test/unit/doctors/check-doctor.test.ts
git commit -m "feat: diagnose configured check failures"
```

## Task 10: Orchestrate Scans and Normalize Results

**Files:**

- Create: `src/core/scan.ts`
- Create: `src/core/normalize.ts`
- Modify: `src/core/summary.ts`
- Create: `test/unit/core/scan.test.ts`
- Create: `test/unit/core/normalize.test.ts`

**Step 1: Write failing orchestration tests**

Assert the complete in-memory flow:

- one workspace inventory per scan
- Project Doctor always eligible
- Check Doctor skipped without `runChecks`
- Check Doctor eligible with `runChecks`
- doctor operational failures are retained alongside successful findings
- exact duplicates are removed
- sorting and summary remain deterministic regardless of doctor registration order
- threshold mapping produces intended exit classification

**Step 2: Observe failure**

```bash
npx vitest run test/unit/core/scan.test.ts test/unit/core/normalize.test.ts
```

**Step 3: Implement scan result**

```ts
export interface ScanResult {
  schemaVersion: "1";
  tool: { name: "codebase-doctor"; version: string };
  repository: { root: string };
  projects: readonly DetectedProject[];
  doctorRuns: readonly DoctorRunRecord[];
  findings: readonly Finding[];
  summary: FindingSummary;
}
```

Normalize before reporters see the result. Keep exit-code calculation as a pure function of scan outcome and `failOn`.

**Step 4: Verify and commit**

```bash
npx vitest run test/unit/core
npm run typecheck
git add src/core test/unit/core
git commit -m "feat: orchestrate deterministic scans"
```

## Task 11: Add Text and JSON Reporters

**Files:**

- Create: `src/reporters/text.ts`
- Create: `src/reporters/json.ts`
- Create: `test/unit/reporters/text.test.ts`
- Create: `test/unit/reporters/json.test.ts`

**Step 1: Write failing reporter tests**

Text assertions:

- detected projects and execution status are visible
- severity labels and evidence are readable
- remediation appears when supplied
- no ANSI color in `NO_COLOR` or non-TTY mode
- empty scan prints an explicit clean summary

JSON assertions:

- valid JSON
- `schemaVersion: "1"`
- all severity count keys exist
- stable order
- no `undefined`-dependent shape changes
- operational failures remain distinct from findings

**Step 2: Observe failure**

```bash
npx vitest run test/unit/reporters
```

**Step 3: Implement pure reporters**

Reporters receive `ScanResult` and return strings. They do not write to stdout and do not decide exit codes.

**Step 4: Verify and commit**

```bash
npx vitest run test/unit/reporters
npm run typecheck
git add src/reporters test/unit/reporters
git commit -m "feat: render text and json reports"
```

## Task 12: Complete the `scan` CLI Command

**Files:**

- Create: `src/commands/scan.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Create: `test/fixtures/node-pass/package.json`
- Create: `test/fixtures/node-fail/package.json`
- Create: `test/fixtures/python-detect/pyproject.toml`
- Create: `test/integration/cli-scan.test.ts`

**Step 1: Create controlled fixtures**

Use Node scripts that are safe, fast, cross-platform, and have deterministic pass/fail behavior. Do not put install hooks in fixtures. Python fixture integration should test read-only detection unless the CI environment explicitly provisions Python tools.

**Step 2: Write failing CLI integration tests**

Cover:

- `scan` defaults to current directory
- explicit path
- default scan does not execute a failing fixture script
- `--run-checks` executes it and exits `1`
- `--json` output parses and reports the command failure
- `--fail-on none` exits `0` while preserving findings
- nonexistent path exits `2`
- invalid timeout/severity exits `2`
- planned commands are displayed before execution in text mode

**Step 3: Observe failure**

```bash
npx vitest run test/integration/cli-scan.test.ts
```

**Step 4: Implement Commander options**

```text
codebase-doctor scan [path]
  --run-checks
  --json
  --timeout <ms>
  --fail-on <info|low|medium|high|critical|none>
```

Default timeout: 120,000 ms per command. Default threshold: high. Validate numeric bounds before scanning. Send operational messages to stderr when JSON output is selected so stdout remains parseable.

**Step 5: Verify complete CLI behavior**

```bash
npm run ci
node dist/cli.js scan test/fixtures/node-pass
node dist/cli.js scan test/fixtures/node-fail --run-checks --json --fail-on none
```

Expected: CI passes; JSON parses; the second scan contains a failed-check finding but exits `0` because threshold is disabled.

**Step 6: Commit**

```bash
git add src test
git commit -m "feat: ship codebase scan command"
```

## Task 13: Package the Agent Skill

**Files:**

- Create: `.agents/skills/codebase-doctor/SKILL.md`
- Create: `.agents/skills/codebase-doctor/agents/openai.yaml`
- Create: `test/unit/skill-contract.test.ts`
- Modify: `README.md`

**Step 1: Write a failing skill contract test**

Read `SKILL.md` and assert:

- valid `name: codebase-doctor` and a trigger-focused description
- read-only scan appears before `--run-checks`
- only implemented CLI options are referenced
- exit codes `0`, `1`, and `2` match CLI behavior
- the skill warns against executing checks in an untrusted repository
- no claim says Codebase Doctor can find every bug

**Step 2: Observe failure**

```bash
npx vitest run test/unit/skill-contract.test.ts
```

**Step 3: Write the minimal skill**

The workflow must instruct compatible agents to:

1. Run `npx codebase-doctor scan . --json` for read-only discovery.
2. Review the project and command plan.
3. Request/confirm execution permission before adding `--run-checks`.
4. Ask a human or separately authorized external coding agent to fix
   evidence-backed findings one at a time.
5. Rerun the exact scan after changes.
6. Never treat exit `2` as a clean scan.

Keep the skill provider-neutral. `openai.yaml` supplies display metadata only.

**Step 4: Update README status truthfully**

Replace planned command language only for behavior that now passes integration tests. Add exact skill location and installation/use instructions verified against the packed artifact.

**Step 5: Verify and commit**

```bash
npx vitest run test/unit/skill-contract.test.ts
npm run ci
git add .agents README.md test/unit/skill-contract.test.ts
git commit -m "feat: add codebase doctor agent skill"
```

## Task 14: Add CI and Package Verification

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `scripts/check-package.mjs`
- Modify: `package.json`
- Create: `test/integration/packed-cli.test.ts`

**Step 1: Write failing packed-artifact test**

The test or script should run `npm pack --json --dry-run`, parse the file list, and assert:

- built CLI and library output included
- README, LICENSE, architecture docs, and agent skill included
- source tests, local environment files, caches, and unrelated workspace files excluded
- package name and version are exactly `codebase-doctor@0.1.0`

**Step 2: Observe failure**

```bash
node scripts/check-package.mjs
```

Expected: FAIL until the script and package metadata are complete.

**Step 3: Add package smoke verification**

Create a temporary directory, run `npm pack` to build the real tarball, install that tarball into the temporary directory without modifying the project, and execute the installed binary against the passing fixture. Clean temporary resources in `finally`.

Add scripts:

```json
{
  "test:package": "node scripts/check-package.mjs && vitest run test/integration/packed-cli.test.ts",
  "ci:full": "npm run ci && npm run test:package && npm audit --audit-level=high"
}
```

**Step 4: Add GitHub Actions**

Use Node 20 and the lockfile:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run ci:full
```

Before committing, verify current official major versions of GitHub-maintained actions and update only if necessary.

**Step 5: Verify and commit**

```bash
npm run ci:full
git diff --check
git status --short
git add .github scripts package.json package-lock.json test/integration/packed-cli.test.ts
git commit -m "ci: verify codebase doctor release package"
```

## Task 15: Validate Against Real Local Repositories and Prepare Release Notes

**Files:**

- Create: `docs/release-checklist.md`
- Create: `CHANGELOG.md`
- Modify: `README.md`

**Step 1: Run read-only scans against representative local repositories**

From the Codebase Doctor repository, run the built CLI against at least:

- Codebase Doctor itself
- RLS Doctor (TypeScript/npm)
- one pnpm monorepo such as MIHA
- one Python repository

Do not use `--run-checks` on a repository with uncommitted user work unless the command plan has been reviewed and the checks are known read-only.

Expected: detection is correct, scans do not modify targets, and surprising findings are reviewed for false positives.

**Step 2: Record false-positive decisions as tests**

For every incorrect finding, create the smallest fixture reproducing it, write a failing regression test, implement the correction, and rerun `npm run ci:full`.

**Step 3: Create release documentation**

`CHANGELOG.md` must list only implemented `0.1.0` behavior. `docs/release-checklist.md` must include:

- npm authentication and 2FA check
- live name availability recheck
- clean Git status
- `npm ci`
- `npm run ci:full`
- `npm pack --dry-run`
- tarball contents review
- README behavior review
- version/tag consistency
- explicit human approval before `npm publish --access public`
- post-publish `npx codebase-doctor@0.1.0 --version` smoke test

**Step 4: Run final verification**

```bash
npm ci
npm run ci:full
npm pack --dry-run
npm publish --dry-run
git diff --check
git status --short
```

Expected: all verification succeeds and the worktree is clean after committing release documentation.

**Step 5: Commit release candidate documentation**

```bash
git add README.md CHANGELOG.md docs/release-checklist.md test src
git commit -m "docs: prepare codebase doctor 0.1 release"
```

**Step 6: Stop before external publication**

Report:

- exact commit SHA
- package name/version
- full verification results
- npm tarball filename and contents summary
- any remaining limitations

Request explicit user approval before running `npm publish --access public` or creating a remote repository/tag.

## Completion Criteria

The implementation is ready for publication only when:

- all unit, integration, security regression, build, audit, and package smoke checks pass
- read-only mode never spawns target commands
- `--run-checks` shows and executes only supported detected plans
- no target fixture or real validation repository is modified
- JSON schema version `1` is stable and documented
- agent skill commands match tested CLI behavior
- README contains no planned feature presented as shipped
- `npm publish --dry-run` succeeds
- user has reviewed the release candidate and explicitly authorized publication
