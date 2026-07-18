# Codebase Doctor

[![npm downloads](https://img.shields.io/npm/dm/codebase-doctor?label=npm%20downloads)](https://www.npmjs.com/package/codebase-doctor)

Codebase Doctor is a model-independent, full-codebase auditor for developers and
coding agents. It turns repository evidence into deterministic findings that a
human or model can inspect and act on.

> **Models build. Codebase Doctor verifies.**

Codebase Doctor exposes no direct target-file write API, has no direct
filesystem-write capability, and includes no remediation executor. It can never
be granted direct target-write or remediation authority. Remediation is
guidance, not an executable repair. A human or separately authorized external
coding agent makes changes; Codebase Doctor then reruns independently to verify
the resulting state.

Separately authorized `--run-checks` launches repository-owned validation
subprocesses. They are not filesystem- or network-isolated and may have side
effects. That permission is validation execution, not Doctor repair authority.

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
Version `0.1.4` includes Git-aware changed audits, conservative workspace and
source-impact planning, model-oriented finding guidance, static and live RLS
coverage, repository-shareable secrets analysis, and offline npm dependency
analysis.

The current Unreleased source also includes the precision-first
`repository/source-integrity` Doctor described below. It is not part of the
published `0.1.4` package.

> **Status:** Published on npm. The current stable line is `0.1.x`, with source, package contents, and clean tarball installation verified in CI.

## Current coverage versus north star

A full audit examines the full requested repository scope for applicable
implemented modules. It does not mean complete analyzer coverage for every
language, framework, or domain. Inspect `doctorRuns` and `coverage` before
calling a codebase verified or clean.

| Domain | Current source coverage | North star |
| --- | --- | --- |
| Repository structure | Bounded inventory, project/framework detection, manifests, workspaces, lockfiles, visible-test diagnostics, a bounded JavaScript/TypeScript source-impact graph, and precision-first missing-target findings | Cross-language dependency and behavioral topology |
| Configured validation | JavaScript/TypeScript and Python command planning; execution only with `--run-checks` | Sandboxed validation across supported ecosystems |
| Database | Offline PostgreSQL migration RLS and separately permitted live PostgreSQL RLS | Schemas, migrations, queries, permissions, drift, and additional database engines |
| Frontend | Framework detection only; repository-owned checks may provide evidence | Built-in React, Next.js, accessibility, SEO, and bundle analysis |
| Backend and authorization | NestJS detection only; repository-owned checks may provide evidence | Built-in API, authentication, worker, webhook, cron, permission, and rate-limit analysis |
| Security | Built-in repository-shareable secrets analysis, offline npm dependency metadata analysis, command-output redaction, and RLS findings; no permission or current advisory analyzer yet | Built-in secrets, cross-ecosystem dependency, permission, vulnerability, and supply-chain analysis |
| Infrastructure | Configuration files may be inventoried but have no semantic analyzer | Built-in Docker, CI, hosting, and deployment analysis |
| Performance | No semantic analyzer | Built-in cache, query, memory, and profiling analysis with explicit runtime permissions |
| AI systems | No semantic analyzer | Built-in prompt, token, model, and grounding analysis with honest statistical limits |

The north-star entries are planned internal modules, not separately installed
Doctor products and not shipped behavior.

The built-in source-impact graph, secrets analysis, and dependency analysis
described below ship together in `0.1.4`. They were not part of the historical
`0.1.3` package.

## Domain coverage inventory

Every text, JSON, and SARIF report includes `domainCoverage`: a fixed checklist
of all nine domains shown above. It separates `applicability` from `status` so
an agent can distinguish “this domain was not detected” from “this domain was
detected but its analysis is unsupported, skipped, failed, or not selected.”
Each entry includes evidence, limitations, and module-level status where a
domain contains more than one analysis module.

For example, the database domain can show the offline `database/sql-rls` module
as completed while the separately permissioned live `database/rls` module is
skipped. The database domain is then partial rather than silently clean.
Changed audits can mark unaffected domains `not-selected`; security and
performance can remain `unknown` and `unsupported` until an applicable analyzer
exists.

`coverageComplete` is true only when the declared applicable, selected analysis
completed, or when the domain is justified as not applicable. `coverageComplete`
does not mean the code is bug-free or correct, and it does not claim that every
possible analyzer exists. Always interpret it with applicability, status,
module details, evidence, limitations, and findings.

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
- Git-aware changed audits covering staged, unstaged, untracked, and branch
  changes with explicit scope metadata.
- Bounded JavaScript/TypeScript source topology and reverse changed-impact
  propagation across internal files and workspaces.
- Precision-first `repository/source-integrity` findings for provably missing
  internal JavaScript and TypeScript import targets.
- SARIF 2.1.0 output for code-scanning integrations.
- Stable text and JSON schema version `1` reports.
- Severity thresholds and CI-friendly exit codes.
- A provider-neutral agent skill.
- A built-in live PostgreSQL RLS analyzer migrated from RLS Doctor.
- Automatic offline PostgreSQL RLS analysis for Supabase, Prisma, Drizzle, and
  generic migration directories.
- Final-state reconstruction for supported table, policy, RLS, and table-grant
  statements, with explicit partial coverage for dynamic or unsupported SQL.
- Explicit, independent permission for database network access.
- Read-only catalog inspection for policies, privileges, roles, memberships,
  RLS enforcement, and bypass paths.
- Automatic offline `security/secrets` analysis for repository-shareable text
  files, with bounded work and secret-safe findings.
- Automatic offline `security/dependencies` analysis for npm lockfile versions
  2 and 3, with bounded work and source-value-safe findings.

Go, Rust, and Java are detection-only in `0.1.x`; Codebase Doctor does not execute their toolchains yet.

## Built-in JavaScript and TypeScript source-impact graph

The combined audit automatically runs the read-only, offline
`repository/source-graph` Doctor for supported JavaScript and TypeScript files.
It recognizes static `import`, re-export, type-only import, literal `require`,
and literal dynamic import edges with a real syntax parser that never executes
repository code. Local `tsconfig` and `jsconfig` files contribute a deterministic
subset of relative aliases and project configuration. This is not complete Node
or TypeScript module resolution.

The graph resolves internal relative, index, selected alias, workspace-package,
and supported package-entry edges. Dynamic non-literal imports, ambiguous
targets, unsupported configuration or syntax, unreadable input, and reached
graph ceilings are coverage limitations, not findings. Cycles are valid source
topology and are not findings. The Doctor intentionally emits no bug findings;
it supplies auditable topology and changed-scope evidence for other analyses.

Schema-1 reports may include `sourceImpact`. Full mode reports graph counts and
coverage. Changed mode additionally walks reverse internal edges, adds impacted
projects to `affectedProjectIds` with a `source-dependent` reason, and reports a
deterministic shortest impact path from each changed source root to each shown
dependant. Reports preserve full impacted-file and omitted-record counts while
serializing only bounded impact records. A path proves only the static edge chain
that selected scope; it does not prove the dependant contains a bug.

Raw import specifiers and source text are withheld from findings, fingerprints,
coverage, limitations, and `sourceImpact`. The module uses no plugins, network
requests, or writes. Inspect `repository/source-graph` coverage before calling
changed source scope clean or verified; partial, unsupported, ambiguous, or
bounded topology cannot support a completeness claim.

## Built-in JavaScript and TypeScript source integrity audit

The current Unreleased source automatically runs the read-only, offline
`repository/source-integrity` Doctor after the graph. The
`repository/source-graph` Doctor remains finding-free; the separate
`repository/source-integrity` Doctor emits the high-confidence
`source/import-target-missing` rule. This separation keeps topology limitations
from becoming guessed bugs.

The Doctor is precision-first and diagnoses only three proof classes: an
explicit relative target with a supported source extension; a single
deterministic alias whose configured target explicitly names a supported source
file; and a unique workspace package whose explicit entry names a supported
source file. Extensionless, JSON, custom-loader, conditional, ambiguous,
external, and dynamic references and cycles are not findings. It does not check
named exports or validate that a referenced export name exists.

Full mode examines all qualifying edges. Changed mode examines changed importers
and complete reverse-impacted importers. A deleted or renamed target selects its
unchanged importer. Raw import specifiers and source text are
withheld; findings expose only normalized repository paths, import kind, proof
class, and safe source location.

The Doctor emits at most 1,000 findings per audit and reports partial coverage
when that ceiling or any upstream graph limitation applies. Partial coverage is
not a clean source-integrity result, and uncertain references remain coverage
limitations rather than findings. An external authorized human or coding agent
must correct or restore the intended target and rerun the same scope. Codebase
Doctor does not modify or repair files.

## Built-in secrets audit

The combined `audit` command automatically runs the read-only, offline
`security/secrets` module. It is precision-first and not exhaustive: it detects
private-key material, documented provider-token shapes, paired AWS credentials,
credential-bearing URLs, and high-confidence sensitive assignments without a
generic file-wide entropy rule.

A Git-ignored local `.env` file is normal runtime storage and is not a finding.
A tracked `.env`, `.env.example`, source file, or other repository-shareable file
containing a real credential is a finding. Full audits use a fixed read-only Git
file listing; changed audits inspect only current changed files. If Git metadata
is unavailable, conservative local-environment fallback rules apply and coverage
is partial.

The matched value is withheld from every finding and never enters a fingerprint,
message, evidence record, error, text report, JSON report, or SARIF report. The
module scans at most 1 MB per file and 100 MB per audit, emits at most 100
findings per file and 1,000 per audit, and reports partial coverage whenever a
limit or read failure prevents complete selected work.

Codebase Doctor does not remove, rotate, revoke, or validate a credential. An
external authorized human or coding agent must remediate the shareable content,
rotate or revoke the credential outside Codebase Doctor, and then rerun the same
audit for independent verification.

## Built-in dependency audit

The combined `audit` command automatically runs the read-only, offline
`security/dependencies` module. Its first supported ecosystem is npm with
lockfile versions 2 and 3. Detected pnpm, Yarn, Bun, Python, and other package
ecosystems remain explicitly unsupported by this module rather than receiving
guessed findings.

The module never invokes npm, another package manager, a shell, an installer,
or a lifecycle script. It makes no network request and does not install,
upgrade, remove, pin, or rewrite dependencies. Full mode analyzes every selected
npm lock root and covered workspace manifest. Changed mode analyzes affected
projects together with their governing npm lock root; an unchanged governing
lockfile may therefore be read as declared scope.

Its precision-first rule families are:

- `security/dependencies/missing-lockfile`
- `security/dependencies/manifest-lock-drift`
- `security/dependencies/insecure-source`
- `security/dependencies/mutable-git-source`
- `security/dependencies/missing-integrity`
- `security/dependencies/workspace-registry-resolution`
- `security/dependencies/competing-npm-lockfiles`

A normal semver range such as `^5.0.0` is not a finding when the supported lock
metadata agrees. The module makes no CVE or current advisory claim; that would
require a separately authorized and freshness-aware vulnerability source.

Raw dependency specifications and resolved URLs can contain credentials. They
are withheld from reports and never enter a fingerprint, evidence record,
message, limitation, error, text, JSON, or SARIF output. Findings use only safe
package names, paths, dependency sections, and coarse source classes. Work is
bounded to 20 MB per lockfile, 100 MB per audit, 100 findings per lock root, and
1,000 findings per audit. A reached limit, unsupported ecosystem, unreadable or
invalid lockfile, or out-of-scope changed project remains visible in coverage.

An external authorized human or coding agent must correct dependency metadata
and rerun the same scope. Codebase Doctor never performs the remediation.
Inspect module coverage before calling the dependency graph clean or verified;
zero findings under partial, unsupported, failed, or not-selected coverage are
not assurance.

## Usage

Run the unified audit without executing checks or opening a database connection:

```bash
codebase-doctor audit .
```

Request JSON for an agent or CI system:

```bash
codebase-doctor audit . --json
```

After making edits, request a changed audit from `HEAD`:

```bash
codebase-doctor audit . --changed --json
```

At a branch review boundary, compare from the merge base with an explicit ref:

```bash
codebase-doctor audit . --changed --base main --json
```

`--base` is optional as a changed-audit mode: without it, discovery compares
against `HEAD` and includes staged, unstaged, and untracked paths. When
`--base` is present it requires a ref operand; a missing operand or invalid ref
exits `2`. An explicit ref includes committed branch changes since the merge
base plus the current staged, unstaged, and untracked worktree. Git discovery
uses only fixed, read-only commands. A requested changed audit that cannot
establish its Git root, revision, merge base, or change list also exits `2`.

The report's `auditScope` is `full` for the default command and `changed` for
`--changed`. Changed mode is mixed-scope, not a universal file filter. Scope
planning selects directly affected projects, conservative internal Node
workspace dependants, and bounded static source dependants. The optional
schema-1 `sourceImpact` object explains the source-level selection with shortest
impact paths, full counts, bounded records, and explicit limitations, but each
doctor applies selection according to its contract. Project Doctor structural
rules run with the full repository snapshot
and may report findings outside changed paths or projects for manifests,
lockfiles, workspaces, and test visibility. Configured validation command plans
are built from the full project topology and then filtered to
`affectedProjectIds`. Static SQL selects affected migration streams and replays
full current history for every selected stream; partial or skipped coverage
records topology limitations. Live database remains a full observed schema-set
audit only with separately requested `--with-database` access.

Unaffected source behavior and domain checks are not broadly covered in changed
mode, while full-context structural doctors may still inspect unaffected areas.
Zero changed findings is not a full clean result. Inspect `auditScope`,
`doctorRuns`, `coverage`, and findings to understand each doctor's actual scope,
including partial, skipped, failed, and limitation records. For a rename both
the new and old path can affect selection; for a copy, only the destination is
treated as changed because the source remains present.

The audit automatically runs offline static SQL analysis when it discovers a
supported PostgreSQL migration stream. It requires no credentials, makes no
network request, and never executes migration SQL. `database/sql-rls` findings
describe expected migration state. Dynamic SQL, malformed input, and unsupported
relevant DDL produce partial coverage. Partial coverage is not a clean result.

Explicitly permit detected project checks:

```bash
codebase-doctor audit . --run-checks
```

`--run-checks` authorizes validation only, not repair. Codebase Doctor does not
select install, format, fix, migration, or deployment commands. Existing target
commands are not currently filesystem- or network-sandboxed and may have side
effects, so review the displayed plan and never run checks for an untrusted
repository. The long-term execution direction is a read-only mount or
disposable copy, not direct target-write authority for Codebase Doctor.

Explicitly permit the live, read-only PostgreSQL RLS audit. Keep the connection
string in the environment rather than command-line arguments:

```bash
DATABASE_URL=postgres://... codebase-doctor audit . --with-database
```

Available options:

```text
--run-checks          Permit configured validation commands
--changed             Audit Git changes and their affected scope
--base <ref>          Compare changed scope from the merge base with this ref
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
Offline migration coverage appears automatically when applicable. The separate
live catalog doctor appears as skipped until `--with-database` is supplied. A
live skip does not mean the deployed database was audited and found clean.

Static and live evidence answer different questions:

- `database/sql-rls` reconstructs expected state from repository migrations.
- `database/rls` inspects observed live database state.

Codebase Doctor does not compare them for deployment drift yet. PostgreSQL is
the only SQL dialect supported by this static module in the current source.

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
baseline is supplied, `--fail-on` applies only to new findings. Changed audits
never report absent baseline findings as resolved because those fingerprints
may be outside the selected scope. Only a comparable full audit can report
absent baseline findings as resolved.

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
- Codebase Doctor has no direct target-file write API, direct filesystem-write
  capability, remediation executor, or direct target-write/remediation authority.
- `--changed` grants no check execution, network, or database permission and no
  direct Doctor target-write authority.
- Offline SQL auditing reads only inventoried migration files, applies a file
  size ceiling, and never evaluates or executes SQL.
- Offline dependency auditing reads bounded npm metadata, never invokes npm or
  another package manager, and never installs or changes dependencies.
- Offline source-impact analysis parses bounded JavaScript/TypeScript syntax but
  never executes source, loads plugins, uses the network, or writes target files.
- Offline source-integrity analysis consumes only the bounded graph, withholds
  raw import values, and never creates, renames, or edits a target file.
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
- `database/sql-rls/*`
- `security/secrets/*`
- `security/dependencies/*`
- `source/import-target-missing`

Every finding contains a rule ID, doctor ID, severity, confidence, category,
explanation, structured evidence, and a stable fingerprint. Applicable findings
also expose machine-readable `impact`, `remediationConstraints`, and
`verification` instructions. Codebase Doctor never executes remediation or the
verification command from a finding. Expected repair means the finding's
fingerprint is absent on rerun and all applicable coverage completed; absence
under partial, skipped, failed, or out-of-scope coverage is not resolution.
Operational failures remain separate in `doctorRuns`.

## Built for coding agents

Codebase Doctor gives any agent the same stable contract regardless of which
model is driving it:

1. Prefer `audit . --changed --json` after edits; run a full audit at trust and
   release boundaries.
2. Read `auditScope`, optional `sourceImpact`, `doctorRuns`, `coverage`, and
   `findings` in the compact, schema-versioned evidence.
3. Let a human or separately authorized external coding agent fix a specific
   finding.
4. Rerun the same scope to verify the external change independently. Do not
   claim a finding resolved outside completed applicable coverage.

The CLI is intentionally model-independent. It can be exposed through a shell,
repository instructions, an agent skill, CI, hooks, or a future MCP server. A
model does not need to know which internal audit module found an issue.

### Agent skill

The npm package includes the provider-neutral skill at:

```text
.agents/skills/codebase-doctor/
```

Copy that directory into a compatible agent's skill directory, or let an agent
load it from the installed package. After edits, the workflow prefers
`codebase-doctor audit . --changed --json`; it uses a full audit at an initial
trust or release boundary. It treats mixed scope, partial, and skipped coverage
explicitly, requests separate permission for `--run-checks` and live
`--with-database` access, asks a human or external agent to fix one
evidence-backed finding at a time, and reruns the same scope.

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

- Compare completed static migration state with observed live catalog state for
  deployment drift.
- Expand source topology beyond the current deterministic JavaScript/TypeScript
  subset and add built-in frontend, backend, security, infrastructure,
  performance, and AI audit coverage without separate doctor installations.
- Report which applicable areas were audited, skipped, unsupported, or blocked
  so an agent never mistakes partial coverage for a clean codebase.
- Add reusable GitHub Action, pull-request annotations, hooks, agent plugins,
  and MCP integration around the same CLI and report schema.
- Run approved validation in read-only mounts or disposable copies so target
  command side effects cannot alter the audited workspace.
- Publish cross-model benchmarks that measure defects found, false positives,
  verification success, runtime, and token/tool-call cost.

Roadmap items are not shipped behavior.

## License

MIT
