# Codebase Doctor

Codebase Doctor is a model-independent CLI that turns repository structure and configured validation commands into deterministic, evidence-backed findings.

> **Status:** `0.1.0` release candidate. The implementation is working locally but has not been published to npm.

## What works in 0.1.0

- Bounded, symlink-safe repository inventory.
- Node.js, JavaScript, TypeScript, Python, Go, Rust, and Java project detection.
- React, Next.js, Vite, and NestJS framework detection.
- npm, pnpm, Yarn, Bun, uv, and Poetry evidence detection.
- Exact and one-level package workspace discovery.
- Structural findings for invalid manifests, conflicting lockfiles, missing workspaces, and absent visible tests.
- Configured JavaScript/TypeScript and Python validation checks.
- Stable text and JSON schema version `1` reports.
- Severity thresholds and CI-friendly exit codes.
- A provider-neutral agent skill.

Go, Rust, and Java are detection-only in `0.1.0`; Codebase Doctor does not execute their toolchains yet.

## Usage

After npm publication, run a read-only scan:

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
--timeout <ms>        Set the per-command timeout (default: 120000)
--fail-on <severity>  info|low|medium|high|critical|none (default: high)
```

Local development usage:

```bash
npm install
npm run build
node dist/cli.js scan . --json
```

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

Approved child commands still inherit host networking in `0.1.0`. Do not execute checks from an untrusted repository. Codebase Doctor coordinates existing tools; it is not a guarantee that every defect will be found.

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
```

Architecture and safety decisions are documented in [docs/architecture.md](docs/architecture.md). The implementation plan is recorded in [docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md](docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md).

## Roadmap

- Go and Rust check adapters.
- Stronger monorepo and Python configuration parsing.
- Diff-aware scans, baselines, and SARIF.
- Pull-request annotations and a reusable GitHub Action.
- External doctor adapters, lifecycle hooks, and MCP tools.

Roadmap items are not shipped behavior.

## License

MIT
