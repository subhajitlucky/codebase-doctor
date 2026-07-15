# Codebase Doctor

[![npm downloads](https://img.shields.io/npm/dm/codebase-doctor?label=npm%20downloads)](https://www.npmjs.com/package/codebase-doctor)

Codebase Doctor is a model-independent, full-codebase auditor for developers and
coding agents. It turns repository evidence into deterministic findings that a
human or model can inspect, fix, and verify.

## One doctor for the whole codebase

The product is one CLI, one configuration file, and one report—not a collection
of separate products such as React Doctor, API Doctor, or RLS Doctor.

Codebase Doctor will automatically detect what a repository contains and run the
audits that apply. Framework- and domain-specific knowledge lives inside the
product as internal audit modules:

```text
codebase-doctor
└── audits
    ├── frontend        React, Next.js, accessibility, SEO, bundles
    ├── backend         APIs, authentication, workers, webhooks, cron
    ├── database        schemas, queries, migrations, RLS
    ├── security        secrets, dependencies, permissions, rate limits
    ├── infrastructure Docker, CI, hosting, deployment
    ├── performance     caching, queries, memory, profiling
    └── ai              prompts, tokens, models, grounding
```

These are implementation boundaries, not tools users must discover, install, or
orchestrate. Existing specialist knowledge—including the rule catalog and
analysis ideas from [RLS Doctor](https://github.com/subhajitlucky/rls-doctor)—can
be incorporated into the relevant internal module while Codebase Doctor remains
the single public interface.

The unified command in the current source is:

```bash
codebase-doctor audit .
```

It combines repository audits and visible coverage for optional internal modules.
The published `0.1.1` package predates this command; `audit` will reach npm in the
next release after package verification.

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
- A built-in live PostgreSQL RLS analyzer migrated from RLS Doctor.
- Explicit, independent permission for database network access.
- Read-only catalog inspection for policies, privileges, roles, memberships,
  RLS enforcement, and bypass paths.

Go, Rust, and Java are detection-only in `0.1.x`; Codebase Doctor does not execute their toolchains yet.

## Usage

Run the unified audit without executing checks or opening a database connection:

```bash
codebase-doctor audit .
```

Request JSON for an agent or CI system:

```bash
codebase-doctor audit . --json
```

Explicitly permit detected project checks:

```bash
codebase-doctor audit . --run-checks
```

Explicitly permit the live, read-only PostgreSQL RLS audit. Keep the connection
string in the environment rather than command-line arguments:

```bash
DATABASE_URL=postgres://... codebase-doctor audit . --with-database
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
--with-database       Permit live PostgreSQL catalog access
--database-schema     Select a database schema; repeatable (default: public)
--database-timeout    Catalog statement timeout in ms (default: 10000)
```

Read-only reports include the validation command plan even when execution is not
permitted. This lets users review the exact commands before adding `--run-checks`.
Database coverage appears as skipped until `--with-database` is supplied. A skip
does not mean the database was audited and found clean.

`codebase-doctor scan` remains available as the backward-compatible,
repository-only command.

## Configuration and exclusions

Place `.codebase-doctor.json` in the scanned repository root:

```json
{
  "exclude": ["test/fixtures/**", "examples/generated/**"]
}
```

Command-line exclusions are combined with configuration exclusions:

```bash
codebase-doctor audit . --exclude 'vendor/**' --json
```

Patterns are repository-relative and support `*`, `?`, and `**`.

## Baselines and SARIF

Save a normal schema-1 JSON report, then compare a later scan with it:

```bash
codebase-doctor audit . --json > codebase-doctor-baseline.json
codebase-doctor audit . --baseline codebase-doctor-baseline.json --json
```

Baseline reports classify fingerprints as new, unchanged, or resolved. When a
baseline is supplied, `--fail-on` applies only to new findings.

Emit SARIF 2.1.0 for code-scanning systems:

```bash
codebase-doctor audit . --format sarif > codebase-doctor.sarif
```

Local development usage:

```bash
npm install
npm run build
node dist/cli.js audit . --json
```

The release package is checked with `npm pack`, installed into a clean temporary project, and executed through its generated `node_modules/.bin/codebase-doctor` command.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Requested audits completed and no finding met the configured threshold. |
| `1` | Requested audits completed and at least one finding met the threshold. |
| `2` | A requested audit could not be completed. |

Exit `2` is an operational failure, not a clean result. `--fail-on none` disables finding-based failure but does not hide findings or operational failures.

## Safety model

- Read-only discovery is the default.
- Target commands require `--run-checks`.
- Live database access requires the separate `--with-database` permission.
- Database credentials are read from `DATABASE_URL` or `SUPABASE_DB_URL`, not a
  connection-string CLI option.
- The RLS module uses a read-only, repeatable-read transaction and never executes
  suggested SQL.
- The scanner never installs target-project dependencies.
- Commands use argument arrays with `shell: false`.
- Per-command time and output limits are enforced.
- Child processes receive a minimal environment.
- Likely secrets are redacted before entering finding evidence.
- Repository-only auditing makes no external network calls.

Approved child commands still inherit host networking in `0.1.x`. Do not execute checks from an untrusted repository. Codebase Doctor combines built-in analysis with explicitly approved project checks; it is not a guarantee that every defect will be found.

## Initial findings

- `repository/conflicting-lockfiles`
- `repository/invalid-manifest`
- `repository/missing-workspace`
- `repository/no-visible-tests`
- `checks/command-failed`
- `checks/command-timeout`
- `database/rls/*`

Every finding contains a rule ID, doctor ID, severity, confidence, category, explanation, structured evidence, stable fingerprint, and remediation when available. Operational failures remain separate in `doctorRuns`.

## Built for coding agents

Codebase Doctor gives any agent the same stable contract regardless of which
model is driving it:

1. Run one repository-wide command.
2. Read compact, schema-versioned evidence.
3. Fix a specific finding.
4. Run the same command again to verify the repair.

The CLI is intentionally model-independent. It can be exposed through a shell,
repository instructions, an agent skill, CI, hooks, or a future MCP server. A
model does not need to know which internal audit module found an issue.

### Agent skill

The npm package includes the provider-neutral skill at:

```text
.agents/skills/codebase-doctor/
```

Copy that directory into a compatible agent's skill directory, or let an agent
load it from the installed package. The workflow starts with
`codebase-doctor audit . --json`, treats skipped coverage explicitly, requests
separate permission for `--run-checks` and `--with-database`, fixes one
evidence-backed finding at a time, and reruns the exact audit.

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

- Release the unified `audit` command and internal RLS module on npm.
- Add static SQL migration analysis to complement live catalog auditing.
- Expand built-in frontend, backend, security, infrastructure, performance, and
  AI audit coverage without requiring separate doctor installations.
- Report which applicable areas were audited, skipped, unsupported, or blocked
  so an agent never mistakes partial coverage for a clean codebase.
- Add reusable GitHub Action, pull-request annotations, hooks, agent plugins,
  and MCP integration around the same CLI and report schema.
- Publish cross-model benchmarks that measure defects found, false positives,
  verification success, runtime, and token/tool-call cost.

Roadmap items are not shipped behavior.

## License

MIT
