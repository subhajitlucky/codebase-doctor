# Codebase Doctor

[![npm version](https://img.shields.io/npm/v/codebase-doctor.svg)](https://www.npmjs.com/package/codebase-doctor)
[![npm downloads](https://img.shields.io/npm/dm/codebase-doctor?label=npm%20downloads)](https://www.npmjs.com/package/codebase-doctor)
[![CI](https://github.com/subhajitlucky/codebase-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/subhajitlucky/codebase-doctor/actions/workflows/ci.yml)

Codebase Doctor is a model-independent, full-codebase auditor for developers and coding agents. It turns repository evidence into deterministic findings that a human or model can inspect and act on.

> **Models build. Codebase Doctor verifies.**

It exposes no direct target-file write API, has no direct filesystem-write capability, and includes no remediation executor. It can never be granted direct target-write or remediation authority. A human or separately authorized external coding agent makes changes; Codebase Doctor is read-only and never modifies, fixes, or repairs target files, then reruns independently to verify the resulting state. Separately authorized `--run-checks` launches repository-owned validation subprocesses; they are not filesystem- or network-isolated and may have side effects. That is validation execution, not Doctor repair authority.

**Status:** published on npm; stable line `0.1.x`, with source, package contents, and clean tarball installation verified in CI. Portfolio case study: <https://subhajitpradhan.vercel.app/projects/codebase-doctor>.

## Quick start

```bash
npx -y codebase-doctor audit . --json                   # run without installing
npm install -g codebase-doctor                          # or install globally
codebase-doctor audit . --json                          # full audit
codebase-doctor audit . --changed --json                # after edits
codebase-doctor audit . --changed --base main --json    # branch review
```

Options:

```text
--run-checks          Permit configured validation commands
--changed             Audit Git changes and their affected scope
--base <ref>          Compare changed scope from the merge base with this ref
--json                Emit schema-versioned JSON
--format <format>     Output format: text, json, sarif, or brief
--exclude <glob>      Exclude a repository-relative path glob; repeatable
--baseline <path>     Compare with a prior Codebase Doctor JSON report
--timeout <ms>        Set the per-command timeout (default: 120000)
--fail-on <severity>  info|low|medium|high|critical|none (default: high)
--require-complete    Fail with exit code 2 when audit coverage is incomplete
--max-findings <n>    Maximum findings rendered in brief output (default: 100)
--with-database       Permit live PostgreSQL catalog access
--with-advisories     Permit one opt-in OSV advisory lookup over resolved supported lockfile packages
--database-schema     Select a database schema; repeatable (default: public)
--database-timeout    Catalog statement timeout in ms (default: 10000)
```

There is one unified auditor: one doctor for the whole codebase, not a collection of separate products. Framework- and domain-specific knowledge lives inside the product as built-in internal audit modules. The unified command is `codebase-doctor audit .`; `scan` remains a backward-compatible repository-only command.

Database modules answer different questions; `database/rls-drift` compares the static and live views when both are available:

- `database/drizzle` inspects supported application source offline for proven Drizzle/postgres-js raw Date parameter hazards.
- `database/sql-rls` reconstructs expected state from repository migrations.
- `database/rls` inspects observed live database state (permissioned with `--with-database`).
- `database/rls-drift` compares reconstructed migration state with the live catalog (permissioned with `--with-database`).

Built-in source-impact graph, secrets analysis, and dependency analysis ship together in `0.1.4`; they are not part of the historical `0.1.3` package. `0.1.5` added `repository/source-integrity`.

## Current coverage versus north star

A full audit examines the full requested repository scope for applicable implemented modules. It is not complete, universal, or every-domain analyzer coverage. Inspect `coverage` before calling a codebase verified or clean.

| Domain | Current source coverage | North star |
| --- | --- | --- |
| Repository structure | Bounded inventory, project/framework detection, manifests, workspaces, lockfiles, visible-test diagnostics, JS/TS + Python + Go + Java + Rust source-impact graph, precision-first missing-target findings | Cross-language dependency and behavioral topology |
| Configured validation | JS/TS and Python command planning; execution only with `--run-checks` | Sandboxed validation across ecosystems |
| Database | Offline PostgreSQL migration RLS, Drizzle/postgres-js raw-Date diagnostics, live PostgreSQL RLS, static-to-live drift comparison | Schemas, migrations, queries, permissions, drift, more engines |
| Frontend | JSX/HTML accessibility (alt text, iframe titles, lang, tab order) and static-HTML SEO checks; framework detection | React, Next.js, bundle analysis, broader a11y and SEO |
| Backend and authorization | NestJS detection only; repository-owned checks may provide evidence | API, auth, worker, webhook, cron, permission, rate-limit analysis |
| Security | Secrets in the working tree and Git history, cross-ecosystem dependency rules, opt-in OSV advisories, command-output redaction; no permission analyzer yet | Secrets, permission, vulnerability, supply-chain analysis |
| Infrastructure | Dockerfile and GitHub Actions analysis | Hosting, deployment, and broader CI analysis |
| Performance | No semantic analyzer | Cache, query, memory, profiling analysis with explicit runtime permissions |
| AI systems | Agent-surface audit: MCP configs (pinning, shell commands, inline credentials, filesystem scope), `SKILL.md` frontmatter and tool grants, permission settings, instruction-file bypass flags; no prompt/model/grounding analyzer yet | Prompt, token, model, grounding analysis with honest statistical limits |

North-star entries are planned internal modules, not separately installed Doctor products and not shipped behavior.

## Domain coverage contract

Every report includes `domainCoverage`: a fixed checklist of the nine domains above. It separates `applicability` from `status` - not-detected differs from detected-but-unsupported, skipped, failed, or not-selected - with `module`-level or modules status details, evidence, and limitations. `coverageComplete` is true only when declared applicable, selected analysis completed, or the domain is justified as not applicable; `coverageComplete` does not mean the code is bug-free or correct. Inspect `coverage` before calling anything verified or clean, and treat partial, skipped, unsupported, or failed coverage as unverified. `--require-complete` fails the run when coverage is incomplete so a skipped area is never reported as clean.

## Changed audits

Changed mode is mixed-scope per doctor, not a universal file filter. Project Doctor structural rules run with the full repository snapshot and may report findings outside changed paths for manifests, lockfiles, workspaces, and test visibility. Configured validation command plans are built from full project topology and then filtered to `affectedProjectIds`. Static SQL selects affected migration streams and replays full current history for every selected stream. Live database remains a full observed schema-set audit only with separately requested `--with-database`. Zero changed findings is not a full clean result.

## Built-in audits

### `database/drizzle` postgres-js Date diagnostic

The read-only, offline `database/drizzle` module and its `database/drizzle/raw-sql-date-parameter` rule catch a runtime boundary: a JavaScript `Date` interpolated into a raw Drizzle `sql` template can bypass the column's timestamp encoder, so postgres-js may throw `ERR_INVALID_ARG_TYPE`; equivalent SQL can still work in psql. Applicability requires confirmed postgres-js usage through an exact `drizzle-orm/postgres-js` adapter import, or scoped owning/workspace evidence for both `drizzle-orm` and `postgres`. It reports only statically proven Date flows such as `new Date()` and supported stable propagation, and does not infer from a variable name.

Not findings: `Date()`, `Date.now()`, an encoded `toISOString()` string, typed comparisons such as `lte(column, date)`, and a fresh inline encoder object with no spreads and a callable `mapToDriverValue` passed directly to `sql.param(value, encoder)`. Encoder identifiers, aliases, member accesses, and calls are not statically proven safe even when declared with `const`, because their objects may be mutated elsewhere; those interpolations, unsupported syntax, and unresolved or unclassified flows become partial coverage limitations rather than guessed findings. Partial coverage is not a clean Drizzle audit. Findings are medium severity, high confidence. Raw SQL, raw expressions, parameter values, and secrets are withheld from findings, fingerprints, text, JSON, and SARIF.

```ts
// Before: raw interpolation can bypass the timestamp column encoder.
const rows = await db.execute(sql`select * from jobs where run_at <= ${date}`);

// After: guidance for a human or separately authorized external coding agent.
const rows = await db.select().from(jobs).where(lte(jobs.runAt, date));
```

An external authorized human or coding agent must preserve timestamp and timezone semantics, make the repair, and rerun the same scope. Codebase Doctor never modifies the query or receives target-write authority.

### `repository/source-graph` (source impact for JS/TS, Python, Go, Java, Rust)

The read-only, offline `repository/source-graph` Doctor recognizes static `import`, re-export, type-only import, literal `require`, and literal dynamic import edges with a real syntax parser that never executes repository code. Local `tsconfig` and `jsconfig` files contribute a deterministic subset of relative aliases; this is not complete Node or TypeScript module resolution.

Beyond JS/TS, each language gets a bounded tokenizer over its import forms: Python (`import`, relative `from`, literal dynamic calls), Go (single and block imports resolved through `go.mod`), Java (package imports from Maven/Gradle roots), and Rust (`mod` and `use` with `crate::`/`self::`/`super::`). Unprovable cases - attribute-only Python imports, namespace packages, Go `go.work` layouts, Java wildcards or generated classes, Rust macros or path attributes - stay limitations instead of guessed edges.

Dynamic non-literal imports, ambiguous targets, unsupported configuration or syntax, unreadable input, and graph ceilings are coverage limitations, not findings. Cycles are valid topology and are not findings. The Doctor intentionally emits no bug findings.

Schema-1 reports may include `sourceImpact` (schema `1`). Full mode reports graph counts and coverage. Changed mode walks reverse internal edges, adds impacted projects to `affectedProjectIds`, and reports a deterministic shortest impact path per changed source root. Reports preserve full impacted-file counts while serializing only bounded impact records. A path proves only the static edge chain, not a bug in the dependant. Raw import specifiers and source text are withheld; the module uses no plugins, network requests, or writes. Inspect `repository/source-graph` coverage before calling changed scope clean or verified.

### `repository/source-integrity` (missing import targets)

The read-only, offline `repository/source-integrity` Doctor runs after the graph. `repository/source-graph` remains finding-free; the separate `repository/source-integrity` Doctor emits the high-confidence `source/import-target-missing` rule, keeping topology limitations from becoming guessed bugs.

It is precision-first and diagnoses only four proof classes: an explicit relative target with a supported source extension; a single deterministic alias whose configured target explicitly names a supported source file; a unique workspace package whose explicit entry names a supported source file; and an internal Go package under a module path without a `replace` directive. Python relative module imports (`from .models import x`) contribute the relative-explicit proof; bare `from . import name` attribute imports and absolute internal imports without a present file are never findings because Python can resolve them through attributes, namespace packages, or path configuration. Extensionless, JSON, custom-loader, conditional, ambiguous, external, and dynamic references and cycles are not findings. It does not check named exports or validate that a referenced export name exists.

Full mode examines all qualifying edges; changed mode examines changed importers and complete reverse-impacted importers. A deleted or renamed target selects its unchanged importer. Raw import specifiers and source text are withheld; findings expose only normalized paths, import kind, proof class, and safe location. The Doctor emits at most 1,000 findings per audit and reports partial coverage when that ceiling or any upstream graph limitation applies. Partial coverage is not a clean source-integrity result. An external authorized human or agent must correct or restore the intended target and rerun the same scope; Codebase Doctor does not modify or repair files.

### `security/secrets`

The read-only, offline `security/secrets` module is precision-first and not exhaustive: it detects private-key material, provider-token shapes, paired AWS credentials, credential-bearing URLs, and high-confidence sensitive assignments without a generic file-wide entropy rule.

A Git-ignored local `.env` is normal runtime storage and is not a finding. A tracked `.env`, `.env.example`, or other repository-shareable file containing a real credential is a finding. Full audits use a fixed read-only Git file listing; changed audits inspect only current changed files; without Git metadata, conservative fallback rules apply and coverage is partial. The matched value is withheld from every finding and never enters a fingerprint, message, evidence record, error, text, JSON, or SARIF report. Scans are bounded to 1 MB per file and 100 MB per audit, at most 100 findings per file and 1,000 per audit, with partial coverage whenever a limit or read failure prevents complete work. Codebase Doctor does not remove, rotate, revoke, or validate a credential; an external authorized human or agent must remediate the shareable content, rotate or revoke outside Codebase Doctor, and rerun the same audit.

### `security/secrets-history`

The read-only, offline `security/secrets-history` module inspects recent Git history for credential-shaped values that were committed and later deleted from the working tree, so a rotated-looking repository does not hide an exposed secret. It uses fixed read-only Git commands over the audited subtree, never checks out, rewrites, or executes repository content, and withholds every matched value from findings, fingerprints, evidence, errors, and reports.

History scanning is bounded to the most recent 200 commits across all branches and 20 MB of patch output, with partial coverage whenever Git history is unavailable or a bound truncates the scan. A value that still matches current tracked content is reported only by `security/secrets`, not duplicated here. Changed audits report this module as not-selected because history coverage is not scope-selected there. Remediation is an external rotation or revocation first, then an authorized history-rewriting workflow; Codebase Doctor does not rewrite history.

### `security/dependencies`

The read-only, offline `security/dependencies` module supports npm lockfile versions 2 and 3, plus cross-ecosystem rules for `pnpm-lock.yaml` (v5+), `yarn.lock` (v1 and Berry), and text `bun.lock` when the project declares or shows that manager. Python and other ecosystems remain explicitly unsupported rather than receiving guessed findings. The module never invokes npm, another package manager, a shell, an installer, or a lifecycle script; it makes no network request and does not install, upgrade, remove, pin, or rewrite dependencies. Changed mode analyzes affected projects with their governing lock root.

Precision-first rule families: `security/dependencies/missing-lockfile`, `security/dependencies/manifest-lock-drift`, `security/dependencies/insecure-source`, `security/dependencies/mutable-git-source`, `security/dependencies/missing-integrity`, `security/dependencies/workspace-registry-resolution`, `security/dependencies/competing-npm-lockfiles`, and `security/dependencies/competing-lockfiles`.

A normal semver range such as `^5.0.0` is not a finding when lock metadata agrees. Cross-ecosystem rules only compare what the lockfile actually records: pnpm importer specifiers, Yarn descriptor ranges, and Bun workspace specifiers are compared against the manifest, while missing importer entries, lockfiles that record no manifest ranges, and unsupported formats stay visible as coverage limitations instead of guessed drift. The module makes no CVE or current advisory claim; that would need a separately authorized, freshness-aware vulnerability source. Raw dependency specifications and resolved URLs are withheld from reports and never enter a fingerprint, evidence record, message, limitation, error, or report output. Work is bounded to 20 MB per lockfile, 100 MB per audit, 100 findings per lock root, and 1,000 per audit; a reached limit or unsupported ecosystem stays visible in coverage. An external authorized human or agent must correct metadata and rerun the same scope. Inspect coverage before calling the dependency graph clean or verified.

### `security/advisories` (opt-in network lookup)

`audit . --with-advisories` performs one bounded OSV lookup for resolved packages from every discovered supported lockfile: `package-lock.json` (v2/v3), `pnpm-lock.yaml` (v5+), `yarn.lock` (v1 and Berry), `bun.lock` (text form), `poetry.lock`, and `uv.lock`. It sends only package names, versions, and ecosystems to api.osv.dev; no source, credentials, or file contents leave the machine, and nothing is written. Without the flag the module is not registered, so an unrequested lookup never marks the security domain incomplete; the MCP server never enables it.

Results are point-in-time: coverage records that advisory data can change as new advisories publish, and a failed or partial lookup is never a clean result. Findings are high-confidence and report the advisory id, aliases, severity, and a fixed version when the advisory provides one. Remediation is an external upgrade through the repository's authorized package manager, followed by rerunning the same scope with `--with-advisories`. Advisory lookup uses the least-privilege `network:advisories` capability, which does not grant live-database access.

### `database/sql-rls`, `database/rls`, and repository structure

Offline `database/sql-rls` automatically runs when a supported PostgreSQL migration stream is discovered: it requires no credentials, makes no network request, and never executes migration SQL, reconstructing expected table, policy, RLS, and grant state from supported migrations. Partial coverage is not a clean static SQL result; dynamic or unsupported DDL stays visible as a coverage limitation. Live `database/rls` inspects observed database state through a read-only catalog of policies, privileges, roles, memberships, enforcement, and bypass paths, permissioned separately with `--with-database` using environment credentials and a read-only, repeatable-read transaction. Repository structure covers bounded, symlink-safe inventory of Node.js, JavaScript, TypeScript, Python, Go, Rust, and Java detection evidence, structural findings for invalid manifests, conflicting lockfiles, missing workspaces, and absent visible tests, plus validation command planning (execution only with `--run-checks`).

### `database/rls-drift`

With `--with-database`, the read-only `database/rls-drift` module compares reconstructed static migration state with the live catalog: table existence, RLS and FORCE RLS enablement, policy names, and explicit migration grants. It reports "your migrations say X, the live database says Y" as `table-missing-live`, `rls-disabled-live`, `force-rls-disabled-live`, `policy-missing-live`, `grant-missing-live` (migrations ahead of production) and `rls-enabled-live-only`, `policy-unmanaged-live` (live changes absent from migrations). It never executes DDL, never compares policy expressions or live-only grants, and only compares dimensions whose static state is fully reconstructed; schemas outside the `--database-schema` selection, dynamic DDL, incomplete policy or grant state, and an unavailable privilege catalog become partial coverage instead of guessed findings. Changed audits report the module as not-selected. Reconcile only through the repository's authorized migration and migration-review workflow, then rerun the same audit.

### `ai/agent-surface`

The read-only, offline `ai/agent-surface` module audits the repository's agent configuration surface. It never executes a configured command, never connects to an MCP server, and never prints a suspected credential value.

- MCP client configs (`mcp.json`, `.mcp.json`, `claude_desktop_config.json`, and `.cursor/`, `.vscode/`, `.github/copilot/` variants): unpinned package runners, shell commands, inline credential values (withheld and never fingerprinted), and broad filesystem grants.
- `SKILL.md` files: non-empty `name` and `description` frontmatter, and no unscoped `allowed-tools` grants (`Bash(*)`, bare `Bash`, `Write`, `Edit`) - reported as `skill-broad-tool-grant`.
- Permission settings and instruction files: `bypassPermissions`/`chat.tools.autoApprove`/`yes-always` modes, unscoped `permissions.allow` rules, hook commands (text withheld), and `--dangerously-skip-permissions`/`--yolo` flags inside instruction or prompt code content are reported as `permission-bypass`, `broad-permission-allow`, `hook-shell-command`, or `instruction-permission-bypass`. Prose mentions are not findings.

Malformed configurations stay visible as coverage limitations, not findings. Nothing on this surface is executed or contacted.

### `frontend/accessibility` and `frontend/seo`

The read-only, offline frontend modules analyze renderable sources without running a browser or a build:

- `frontend/accessibility` inspects JSX/TSX and static HTML for `img-missing-alt`, `iframe-missing-title`, `html-missing-lang`, and `positive-tabindex` (a positive `tabIndex` overrides natural focus order). JSX elements with spread props are skipped because a provider could supply the attribute, and unparsable JSX becomes a limitation.
- `frontend/seo` inspects static HTML for a non-empty `title` (`missing-title`, medium) and a non-empty `meta description` (`missing-meta-description`, low). Framework-generated documents are out of scope because their metadata lives in application code.

HTML comments are ignored so commented-out tags are not findings. Malformed JSX, unreadable files, and reached limits become partial coverage.

### `infrastructure/docker` and `infrastructure/github-actions`

The read-only, offline infrastructure modules analyze deployment configuration without building, running, or rewriting anything:

- `infrastructure/docker` reads Dockerfiles (including `*.dockerfile`) and reports `unpinned-base-image` (no tag or `latest`), `remote-add` (remote URL fetched by ADD), `pipe-to-shell` (curl or wget piped into a shell), `world-writable` (chmod 777 or a+rwx), and `root-user` (USER root or 0). Build-arg-driven base images stay visible as limitations.
- `infrastructure/github-actions` reads `.github/workflows/*.yml` and reports `script-injection` (attacker-controlled `github.event` or `github.head_ref` expressions interpolated into `run:` steps), `pull-request-target-checkout` (pull_request_target job checking out the PR head), `write-all-permissions`, and `unpinned-action` (action refs pinned to mutable branches rather than a commit SHA or version tag).

Workflows are never dispatched and images are never built. Malformed YAML, unreadable files, and reached limits become partial coverage.

## Precision and bounded-report contract

Workspace publication entries, generated targets, and fixture-controlled paths are coverage limitations unless independently proven broken; they are not missing-target findings by themselves. Detected pnpm, Yarn, and Bun scopes never receive npm-specific findings. Only a cryptographic match to an inventoried localhost-only certificate can classify a private key as an intentional local test key; every other matched private key remains high severity.

Schema-1 reports bound repeated evidence without hiding its size: `coverageSummary` preserves exact `total`, `emitted`, and `omitted` counts, and `limitationGroups` preserve each reason, deterministic sample paths, and omitted path counts. These fields are additive. Codebase Doctor never modifies, fixes, or repairs target files.

## Agents

- `codebase-doctor instructions` prints ready-to-paste snippets for `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/codebase-doctor.mdc`, `.windsurfrules`, `.clinerules/`, `.github/copilot-instructions.md`, and MCP client setup. It only prints; it never writes files.
- `--format brief` is token-bounded, findings-only output with scope/coverage header, truncation notice, and coverage limitations; `--max-findings` (default 100) caps it, and baseline runs mark `+` new and `=` unchanged.
- `verify . --baseline before.json` reports each baseline fingerprint as `resolved` (absent + all applicable coverage completed), `unchanged`, `unresolved` (absent under incomplete coverage - never a repair), or `new`. Exit 1 unless everything is verifiably resolved (`--allow-unchanged` relaxes unchanged entries).
- `codebase-doctor mcp` serves read-only tools over stdio: `audit_codebase`, `verify_changes`, `explain_finding`, and `describe_capabilities`. Responses are bounded at roughly 50 KB; the server never enables `--run-checks` or live database access. Register it with `claude mcp add codebase-doctor -- npx -y codebase-doctor mcp` or the equivalent client config.
- The npm package includes the provider-neutral skill at `.agents/skills/codebase-doctor/`: prefer a changed audit after edits, a full audit at trust boundaries, one evidence-backed fix at a time, and rerun the same scope.

Workflow: `audit . --changed --format brief` after edits; full `audit .` at trust or release boundaries; save a baseline with `audit . --json > baseline.json`; after external repair, `verify . --baseline baseline.json`; never claim resolution outside completed applicable coverage.

## Baselines, SARIF, and GitHub Action

`--baseline` classifies fingerprints as new, unchanged, or resolved and applies `--fail-on` only to new findings; changed audits never report absent baseline findings as resolved. `--format sarif` emits SARIF 2.1.0 for code scanning. The composite GitHub Action at the repository root installs the published CLI, writes the report, and fails per `fail-on`/`require-complete`; see [docs/github-action.md](docs/github-action.md) for a workflow with SARIF upload.

```yaml
- uses: subhajitlucky/codebase-doctor@v0.1.9
  with:
    fail-on: high
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Requested audits completed and no finding met the threshold. |
| `1` | Requested audits completed and at least one finding met the threshold. |
| `2` | A requested audit could not be completed, or coverage was incomplete while `--require-complete` was set. |

Exit `2` is an operational failure, not a clean result. `--fail-on none` disables finding-based failure but does not hide findings or operational failures.

## Safety model

- Read-only discovery is the default. No permission is implied by an audit: `--changed` grants no check execution, network, or database access.
- Target commands require `--run-checks`; live database access requires `--with-database`; database credentials come from `DATABASE_URL` or `SUPABASE_DB_URL`, never a connection-string option.
- SQL auditing reads inventoried migration files only and never executes SQL; the live RLS modules use read-only transactions.
- Dependency auditing reads bounded lockfile metadata and never invokes a package manager or changes dependencies. Source analysis parses bounded syntax and never executes source. Agent configuration is parsed but never executed or contacted.
- Validation commands use argument arrays with `shell: false`, minimal environments, and per-command time and output limits. Apart from an explicitly requested `--with-advisories` OSV lookup, the scanner makes no external network calls.

## Roadmap

- Add built-in backend, performance, and AI semantic audit coverage without separate doctor installations.
- Extend coverage guarantees beyond the current global `--require-complete` gate.
- Add pull-request annotations, hooks, and agent plugins around the same CLI and report schema.
- Run approved validation in read-only mounts or disposable copies.
- Publish cross-model benchmarks measuring defects found, false positives, verification success, runtime, and token/tool-call cost.

Roadmap items are not shipped behavior. Architecture is documented in [docs/architecture.md](docs/architecture.md); the implementation plan lives in [docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md](docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md).

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm run ci:full
```

The release package is checked with `npm pack`, installed into a clean temporary project, and executed through its generated `node_modules/.bin/codebase-doctor` command.

## License

MIT
