# Codebase Doctor

Codebase Doctor is a planned model-independent CLI for diagnosing human- and AI-written software.

It will inspect a repository, identify its languages and tooling, run explicitly approved validation checks, and return one evidence-backed report that humans, coding agents, and CI systems can understand.

> **Status:** Architecture approved; `0.1.0` is not implemented or published yet.

## Product Promise

Modern coding agents can create software quickly, but a confident answer is not proof that the software works. Codebase Doctor is intended to be the verification layer after code changes:

```text
Human or AI changes code
        |
        v
Codebase Doctor inspects the repository
        |
        +--> detects languages, frameworks, and package managers
        +--> runs approved tests, builds, linters, and type-checkers
        +--> normalizes failures into evidence-backed findings
        |
        v
Human-readable and machine-readable report
```

The deterministic diagnostic engine is the product. AI may later explain or repair verified findings, but an AI opinion will not be treated as evidence by itself.

## Planned `0.1.0`

The first release will deliberately do two things well.

### 1. Project Doctor

Read-only repository inspection:

- Detect common languages, frameworks, manifests, workspaces, and package managers.
- Recognize monorepos and mixed-language repositories.
- Report conflicting lockfiles and unreadable or invalid manifests.
- Inventory configured test, build, lint, and type-check commands.
- Highlight source areas with no visible test files as a coverage signal, not proof of missing coverage.

### 2. Check Doctor

Explicitly approved command execution for JavaScript/TypeScript and Python projects:

- Discover existing project checks instead of inventing commands.
- Show the execution plan before running checks.
- Run checks only when the user supplies `--run-checks`.
- Apply timeouts and output limits.
- Never install dependencies, enable network access, or modify project files.
- Convert failed checks into the same normalized finding format.

## Planned Usage

The following commands describe the approved interface. They will become available after `0.1.0` is implemented and published.

Read-only inspection:

```bash
npx codebase-doctor scan .
```

Run detected validation checks with explicit permission:

```bash
npx codebase-doctor scan . --run-checks
```

Machine-readable output for coding agents and CI:

```bash
npx codebase-doctor scan . --run-checks --json
```

Planned example:

```text
Codebase Doctor

Repository: ./my-app
Detected: TypeScript, Next.js, pnpm workspace

HIGH  tests/check-failed
      The configured test command exited with code 1.
      Evidence: pnpm test
      Next step: inspect the failing test output attached to this finding.

MEDIUM repository/conflicting-lockfiles
       Both pnpm-lock.yaml and package-lock.json are present.
       Next step: keep the lockfile for the package manager used by this repo.

Summary: 1 high, 1 medium
```

## Finding Contract

Every doctor will produce the same core information:

```text
Rule ID
Doctor ID
Severity
Confidence
Category
Title and explanation
File and line when known
Evidence and reproduction command when safe
Suggested next step
```

Stable normalized findings allow the same scan to power terminal output, JSON, SARIF, GitHub annotations, agent tools, and future dashboards.

## Safety Principles

- **Read-only by default:** scanning must not change the target repository.
- **Execution requires consent:** project commands run only with `--run-checks`.
- **No surprise installation:** Codebase Doctor never installs target dependencies.
- **No network by default:** checks do not receive network permission from Codebase Doctor.
- **Bounded execution:** subprocesses receive time and output limits.
- **Evidence before confidence:** findings must explain what was observed.
- **No secret leakage:** reporters redact likely credentials and sensitive environment values.
- **No fake universality:** support for a language means a tested adapter exists for it.

## Agent-Native Direction

Codebase Doctor will remain useful without an AI model. Agent integrations will be separate surfaces built on the same deterministic core:

```text
Core CLI
  +--> JSON and SARIF reports
  +--> GitHub Action
  +--> Codex and Claude skills
  +--> lifecycle hooks
  +--> MCP server
  +--> controlled repair workflow
```

The intended agent loop is:

1. An agent changes code.
2. Codebase Doctor scans the changed repository.
3. The agent reads structured, reproducible findings.
4. The agent fixes one finding in an isolated branch or worktree.
5. Codebase Doctor verifies whether the repair improved the result.

## What Codebase Doctor Is Not

- Not a claim that one tool can understand every language on day one.
- Not a replacement for compilers, linters, tests, or security scanners.
- Not an LLM prompt that guesses whether code looks correct.
- Not an automatic fixer that silently edits a repository.
- Not a wrapper that hides the command and evidence behind a score.

Codebase Doctor coordinates proven checks, adds high-signal cross-project diagnostics, and gives every result one stable contract.

## Roadmap

| Release | Intended focus |
| --- | --- |
| `0.1` | Project detection, JavaScript/TypeScript and Python check execution, text and JSON reports |
| `0.2` | Go and Rust adapters, stronger monorepo discovery |
| `0.3` | Diff-aware scans, baselines, SARIF output |
| `0.4` | External doctor adapters, including RLS Doctor where applicable |
| `0.5` | GitHub Action and pull-request annotations |
| `0.6` | Agent skills, lifecycle-hook installers, and MCP server |
| `1.0` | Stable doctor SDK and controlled, verification-gated repair workflow |

Roadmap items are direction, not shipped features.

## Architecture

See [Project Architecture](docs/architecture.md) for module boundaries, data flow, safety controls, doctor contracts, and testing strategy.

The approved product decisions are recorded in [the design document](docs/plans/2026-07-15-codebase-doctor-design.md).

## Development Status

Implementation has not started. The next milestone is to scaffold the TypeScript CLI using Node.js 20+, Commander, tsup, and Vitest, then implement the two `0.1.0` doctors test-first.

The package is intended to use the MIT license before its first public release.
