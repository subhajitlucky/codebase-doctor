# Codebase Doctor

[![npm downloads](https://img.shields.io/npm/dm/codebase-doctor?label=npm%20downloads)](https://www.npmjs.com/package/codebase-doctor)

Codebase Doctor is a model-independent CLI that turns repository structure and configured validation commands into deterministic, evidence-backed findings.

The long-term product direction is a model-independent verification control
plane for coding agents: a doctor-of-doctors that coordinates specialist tools,
normalizes their evidence, and verifies repairs. See the
[agent verification platform design](docs/plans/2026-07-15-agent-verification-platform-design.md).

> **Status:** Published on npm. The current stable line is `0.1.x`, with source, package contents, and clean tarball installation verified in CI.

## What works in the current source

- Bounded, symlink-safe repository inventory.
- Node.js, JavaScript, TypeScript, Python, Go, Rust, and Java project detection.
- React, Next.js, Vite, and NestJS framework detection.
- npm, pnpm, Yarn, Bun, uv, and Poetry evidence detection.
- Exact and one-level package workspace discovery.
- Structural findings for invalid manifests, conflicting lockfiles, missing workspaces, and absent visible tests.
- Configured JavaScript/TypeScript and Python validation checks.
- Read-only validation command previews.
- Configurable repository exclusions.
- Fingerprint-based baseline comparisons.
- SARIF 2.1.0 output for code-scanning integrations.
- Stable text and JSON schema version `1` reports.
- Severity thresholds and CI-friendly exit codes.
- A provider-neutral agent skill.

Go, Rust, and Java are detection-only in `0.1.x`; Codebase Doctor does not execute their toolchains yet.

## Usage

Run a read-only scan:

```bash
npx codebase-doctor scan .
```

Request JSON for an agent or CI system:

```bash
npx codebase-doctor scan . --json
```

Explicitly permit detected project checks:

```bash
npx codebase-doctor scan . --run-checks
```

Available options:

```text
--run-checks          Permit configured validation commands
--json                Emit schema-versioned JSON
--format <format>     Output text, json, or sarif
--exclude <glob>      Exclude a repository-relative path glob; repeatable
--baseline <path>     Compare with a prior Codebase Doctor JSON report
--timeout <ms>        Set the per-command timeout (default: 120000)
--fail-on <severity>  info|low|medium|high|critical|none (default: high)
```

Read-only reports include the validation command plan even when execution is not
permitted. This lets users review the exact commands before adding `--run-checks`.

## Configuration and exclusions

Place `.codebase-doctor.json` in the scanned repository root:

```json
{
  "exclude": ["test/fixtures/**", "examples/generated/**"]
}
```

Command-line exclusions are combined with configuration exclusions:

```bash
npx codebase-doctor scan . --exclude 'vendor/**' --json
```

Patterns are repository-relative and support `*`, `?`, and `**`.

## Baselines and SARIF

Save a normal schema-1 JSON report, then compare a later scan with it:

```bash
npx codebase-doctor scan . --json > codebase-doctor-baseline.json
npx codebase-doctor scan . --baseline codebase-doctor-baseline.json --json
```

Baseline reports classify fingerprints as new, unchanged, or resolved. When a
baseline is supplied, `--fail-on` applies only to new findings.

Emit SARIF 2.1.0 for code-scanning systems:

```bash
npx codebase-doctor scan . --format sarif > codebase-doctor.sarif
```

Local development usage:

```bash
npm install
npm run build
node dist/cli.js scan . --json
```

The release package is checked with `npm pack`, installed into a clean temporary project, and executed through its generated `node_modules/.bin/codebase-doctor` command.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Scan completed and no finding met the configured threshold. |
| `1` | Scan completed and at least one finding met the threshold. |
| `2` | The requested scan could not be completed. |

Exit `2` is an operational failure, not a clean result. `--fail-on none` disables finding-based failure but does not hide findings or operational failures.

## Safety model

- Read-only discovery is the default.
- Target commands require `--run-checks`.
- The scanner never installs target-project dependencies.
- Commands use argument arrays with `shell: false`.
- Per-command time and output limits are enforced.
- Child processes receive a minimal environment.
- Likely secrets are redacted before entering finding evidence.
- Scanner logic makes no external network calls.

Approved child commands still inherit host networking in `0.1.x`. Do not execute checks from an untrusted repository. Codebase Doctor coordinates existing tools; it is not a guarantee that every defect will be found.

## Initial findings

- `repository/conflicting-lockfiles`
- `repository/invalid-manifest`
- `repository/missing-workspace`
- `repository/no-visible-tests`
- `checks/command-failed`
- `checks/command-timeout`

Every finding contains a rule ID, doctor ID, severity, confidence, category, explanation, structured evidence, stable fingerprint, and remediation when available. Operational failures remain separate in `doctorRuns`.

## Agent skill

The npm package includes the provider-neutral skill at:

```text
.agents/skills/codebase-doctor/
```

Copy that directory into a compatible agent's skill directory, or let an agent load it from the installed package. The workflow starts with `npx codebase-doctor scan . --json`, requires confirmation before adding `--run-checks`, fixes one evidence-backed finding at a time, and reruns the exact scan.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run ci
npm run ci:full
```

Architecture and safety decisions are documented in [docs/architecture.md](docs/architecture.md). The implementation plan is recorded in [docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md](docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md).

## Roadmap

- Go and Rust check adapters.
- Stronger monorepo and Python configuration parsing.
- Reusable GitHub Action and pull-request annotations.
- External doctor adapters, lifecycle hooks, and MCP tools.

Roadmap items are not shipped behavior.

## License

MIT
