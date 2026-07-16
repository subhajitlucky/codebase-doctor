# Independent Auditor Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Permanently establish Codebase Doctor as an independent auditor that can diagnose and verify but can never modify or coordinate modification of a target.

**Architecture:** Narrow the Doctor capability contract to read, validation execution, and separately approved network access. Make canonical and historical documentation use the same three-actor workflow: Codebase Doctor diagnoses, a human or external agent fixes, and Codebase Doctor independently verifies. Lock the boundary with TypeScript and documentation contract tests.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, Markdown contract tests, existing Codebase Doctor CI and package verification.

---

### Task 1: Remove target-write authority from the capability contract

**Files:**
- Modify: `src/core/capabilities.ts`
- Modify: `test/unit/core/registry.test.ts`
- Create: `test/unit/core/capability-contract.test.ts`

**Step 1: Write the failing type contract**

Create a test file that imports `Capability`, exercises the three supported
values, and uses `@ts-expect-error` to require rejection of target write:

```ts
import { describe, expect, it } from "vitest";
import type { Capability } from "../../../src/core/capabilities.js";

function capability(value: Capability): Capability {
  return value;
}

describe("Doctor capability boundary", () => {
  it("contains only read, validation execution, and network access", () => {
    expect([
      capability("filesystem:read"),
      capability("process:execute"),
      capability("network:access"),
    ]).toHaveLength(3);

    // @ts-expect-error Codebase Doctor permanently has no target-write authority.
    capability("filesystem:write");
  });
});
```

**Step 2: Verify RED**

Run:

```bash
npm run typecheck
```

Expected: FAIL because the `@ts-expect-error` directive is unused while the
current capability union still accepts `filesystem:write`.

**Step 3: Remove the capability**

Delete `filesystem:write` from `Capability`. Change the registry denial test
from a parameterized network/write case to a network-only case. Do not add a
replacement write, patch, fix, mutation, Git, migration, or deployment
capability.

**Step 4: Verify GREEN**

Run:

```bash
npx vitest run test/unit/core/capability-contract.test.ts test/unit/core/registry.test.ts
npm run typecheck
```

Expected: both commands PASS.

**Step 5: Commit**

```bash
git add src/core/capabilities.ts test/unit/core/capability-contract.test.ts test/unit/core/registry.test.ts
git commit -m "refactor: remove target-write capability"
```

### Task 2: Make the canonical product contract unambiguous

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `.agents/skills/codebase-doctor/SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/release-checklist.md`
- Modify: `test/unit/skill-contract.test.ts`
- Create: `test/unit/product-boundary-contract.test.ts`

**Step 1: Write failing canonical-document tests**

Read the README, architecture, and skill and require all of them to communicate:

```text
Models build. Codebase Doctor verifies.
human or external/separately authorized coding agent performs the fix
Codebase Doctor never edits/applies/repairs the target
remediation is guidance, not an executable repair
```

Reject these positive product claims in canonical documents:

```text
safe repair
controlled repair workflow
repair-loop coordination
AI explanations and repair
filesystem:write
```

Keep tests semantic enough to allow discussion of validation commands and
external agents fixing findings.

**Step 2: Verify RED**

Run:

```bash
npx vitest run test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts
```

Expected: FAIL because README and skill leave the fixer implicit and current
architecture reserves repair and write authority.

**Step 3: Rewrite canonical guidance**

- Add the permanent product principle near the README product definition.
- Replace “Fix a specific finding” with an explicit external-actor step.
- State that `--run-checks` authorizes validation only, not repair; repository
  commands are not currently sandboxed and may have side effects.
- State the long-term execution direction is read-only mounts or disposable
  copies.
- Remove safe repair, write capability, controlled repair workflow, and AI
  repair from architecture.
- Describe future MCP surfaces as inspect/plan/validate/report only.
- Make the skill say the human or separately authorized agent fixes and Codebase
  Doctor only reruns verification.
- Add an Unreleased changelog entry and release-checklist invariant.

**Step 4: Verify GREEN**

Run:

```bash
npx vitest run test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts
npm run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add README.md docs/architecture.md .agents/skills/codebase-doctor/SKILL.md CHANGELOG.md docs/release-checklist.md test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts
git commit -m "docs: establish permanent auditor independence"
```

### Task 3: Rewrite historical plans to match the permanent vision

**Files:**
- Modify: `docs/plans/2026-07-15-agent-verification-platform-design.md`
- Modify: `docs/plans/2026-07-15-codebase-doctor-design.md`
- Modify: `docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md`
- Modify: `docs/plans/2026-07-15-core-ci-foundation-design.md`
- Modify: `docs/plans/2026-07-15-core-ci-foundation.md`
- Modify: `docs/plans/2026-07-15-static-sql-rls-audit-design.md`
- Modify: `docs/plans/2026-07-15-static-sql-rls-audit.md`
- Modify: `docs/plans/2026-07-15-unified-rls-audit-design.md`
- Modify: `docs/plans/2026-07-15-unified-rls-audit.md`
- Modify: `test/unit/product-boundary-contract.test.ts`

**Step 1: Extend the failing document contract**

Add the nine historical plan files to the contract. Require superseded plans to
use only `Status: Superseded`, not an approved-current status. Reject product
direction that assigns Codebase Doctor write authority, repair execution, or
repair-loop coordination.

Allow historical implementation language about fixing Codebase Doctor itself,
test failures, changelog `Fixed` headings, and an external actor applying a fix.

**Step 2: Verify RED**

Run:

```bash
npx vitest run test/unit/product-boundary-contract.test.ts
```

Expected: FAIL on the superseded doctor-of-doctors documents and their repair
roadmaps.

**Step 3: Rewrite all historical direction**

- Preserve useful implementation history and superseded external-specialist
  context.
- Remove contradictory approved-current statuses.
- Replace repair-loop ownership with post-change verification ownership.
- Remove target-write capability lists and future repair phases.
- Identify the human or external coding agent whenever a finding is fixed.
- Replace repair benchmarks with detection quality, coverage honesty, regression
  prevention, and independent verification benchmarks.
- Keep explicit non-goals against automatic SQL/policy repair.

**Step 4: Search for remaining contradictions**

Run:

```bash
rg -n -i 'safe repair|controlled repair|repair-loop coordination|verification-gated repair|AI explanations and repair|filesystem:write' README.md CHANGELOG.md docs .agents/skills/codebase-doctor/SKILL.md src test
```

Expected: only the approved 2026-07-16 boundary design and implementation plan
may mention rejected terms while defining or testing their prohibition. No
older product document, runtime source, or runtime test may contain them.

**Step 5: Verify GREEN**

Run:

```bash
npx vitest run test/unit/product-boundary-contract.test.ts test/unit/skill-contract.test.ts
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add docs/plans/2026-07-15-*.md test/unit/product-boundary-contract.test.ts
git commit -m "docs: align historical plans with auditor boundary"
```

### Task 4: Verify the permanent boundary and release package

**Files:**
- Modify only files required by verified failures.

**Step 1: Run focused boundary verification**

```bash
npx vitest run test/unit/core/capability-contract.test.ts test/unit/core/registry.test.ts test/unit/skill-contract.test.ts test/unit/product-boundary-contract.test.ts
npm run typecheck
```

Expected: PASS.

**Step 2: Run full normal and package CI**

```bash
npm run ci:full
```

Expected: source tests, package tests, typecheck, build, packed installation,
and dependency audit PASS.

**Step 3: Run Codebase Doctor's self-audit**

```bash
node dist/cli.js audit . --exclude 'test/fixtures/**' --json --fail-on none
```

Expected: exit `0`; findings remain visible; static SQL coverage is
not-applicable; live RLS is skipped without permission.

**Step 4: Inspect final repository state**

```bash
git diff --check
git status --short
git log --oneline -12
```

Expected: no whitespace errors or unintended files. Do not bump, publish, tag,
or push.

**Step 5: Commit verified corrections only if needed**

If verification required changes, commit only those files with a message that
describes the verified correction. Otherwise create no empty commit.
