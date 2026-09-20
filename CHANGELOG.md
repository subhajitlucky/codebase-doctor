# Changelog

All notable changes to Codebase Doctor are documented here.

## [Unreleased]

### Added

- Extend the read-only, offline source-impact graph to Rust: `mod`
  declarations and `use` paths (brace groups expanded) are parsed with a
  bounded tokenizer (line/nested block comments, strings, raw strings, chars,
  lifetimes ignored) and resolved against `src/lib.rs` or `src/main.rs` with
  `crate::`, `self::`, and `super::` support. Adds the `module` import kind;
  missing modules and use targets stay unproven and internal wildcards become
  limitations.
- Extend the read-only, offline source-impact graph to Java: package
  declarations and import statements are parsed with a bounded tokenizer
  (comments, strings, chars, and text blocks ignored), resolved from standard
  Maven/Gradle package roots, with static-import parent fallback, wildcard
  limitations, and no missing-target proof because Java classes can be
  generated or come from a same-package dependency. Adds the `static-import`
  import kind.
- Extend the read-only, offline source-impact graph and source-integrity proof
  to Go: single and block `import` declarations are parsed with a bounded
  tokenizer, resolved against each project's `go.mod` module path, and missing
  internal packages carry the `module-internal` proof only when the module has
  no `replace` directive; `go.work`-only layouts and unreadable metadata stay
  limitations.
- Extend the read-only, offline source-impact graph and source-integrity proof
  to Python: statement-level `import`, `from`-imports with relative dots, and
  literal `importlib.import_module`/`__import__` calls are parsed with a
  bounded tokenizer that ignores comments and strings. Relative module imports
  carry the relative-explicit missing-target proof; bare-dot attribute
  imports, namespace-package layouts, and non-literal dynamic calls remain
  coverage limitations or unproven edges instead of guessed findings.
- Extend the read-only, offline `ai/agent-surface` module with permission
  boundaries and instruction surfaces: documented permission settings
  (`permissions.defaultMode: bypassPermissions`, unscoped `permissions.allow`
  rules, hook commands with text withheld, `chat.tools.autoApprove`,
  Aider `yes-always`/`yes`), unscoped skill `allowed-tools` grants, and
  permission-bypass flags in instruction or prompt code content, plus
  `.mcp.json` discovery.
- Extend the read-only, offline `security/dependencies` module beyond npm:
  projects that declare or expose pnpm, Yarn (v1 and Berry), or Bun lock
  authority are now covered for insecure sources, mutable git references,
  missing integrity or checksums, manifest-lock drift where the lock records
  ranges, missing lockfiles, and `competing-lockfiles`. Only recorded
  dimensions are compared; everything else stays visible as partial coverage.
- Add the read-only `database/rls-drift` module (`--with-database`): compares
  reconstructed static migration state with the live catalog for table
  existence, RLS and FORCE RLS enablement, policy names, and explicit migration
  grants, reporting unapplied migrations and live-only changes while unknown
  static state or an unavailable privilege catalog stays visible as partial
  coverage. It never executes DDL.
- Add the read-only, offline `security/secrets-history` module: bounded Git
  history scanning for credential-shaped values deleted from the working tree,
  with the value withheld, subtree-scoped `git log`, and no duplicate finding
  when the same detector still matches current tracked content.
- Add the read-only, offline `ai/agent-surface` module: audits MCP client
  configurations (unpinned package runners, shell commands, inline credentials
  with the value withheld, broad filesystem grants) and `SKILL.md` frontmatter.
  It never executes configured commands or connects to MCP servers, and the AI
  domain now reports this module instead of a blanket unsupported status.
- Add the opt-in `security/advisories` module (`--with-advisories`): one bounded
  OSV lookup over resolved packages from `package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock` (v1 and Berry), `bun.lock`, `poetry.lock`, and `uv.lock`,
  reporting advisory id, aliases, severity, and a fixed version when available.
  It sends only package names, versions, and ecosystems, is point-in-time by
  design, and keeps coverage partial when the lookup fails. The MCP server never
  enables it.

### Security

- Add the least-privilege `network:advisories` capability so advisory lookups
  cannot grant live-database network access, and gate the module behind the
  explicit `--with-advisories` flag.

## [0.1.8] - 2026-09-20

### Added

- Add the `verify` command: compares a prior schema-1 JSON report with a fresh
  audit and reports each baseline fingerprint as `resolved`, `unchanged`, or
  `unresolved`. Absence under incomplete coverage is never resolved. New
  findings are listed separately, and `--allow-unchanged` relaxes unchanged
  failures.
- Add `--format brief`: token-bounded, findings-only output with scope, coverage,
  truncation, and coverage-limitation lines, plus `--max-findings`
  (default 100).
- Add the `verify_changes` and `explain_finding` MCP tools with the same
  read-only, offline, bounded-payload contract as `audit_codebase`.
- Add `codebase-doctor instructions`: prints ready-to-paste agent instruction
  snippets for `AGENTS.md`, `CLAUDE.md`, Cursor rules, Windsurf, Cline, Copilot,
  and MCP client configuration. The command only prints; it never writes files.

### Changed

- Reduce audit time on large repositories without changing findings: file stats
  and source reads run with bounded concurrency in deterministic order, package
  manifests load in bounded batches, and secret match locations use a linear
  line-start index (about 5x faster on match-dense files).

## [0.1.7] - 2026-09-20

### Added

- Add the read-only, offline `database/drizzle` module and its precision-first
  `database/drizzle/raw-sql-date-parameter` rule for statically proven
  JavaScript Date values interpolated through raw Drizzle SQL on confirmed
  postgres-js paths.
- Add the `codebase-doctor mcp` subcommand: a read-only Model Context Protocol
  stdio server that reuses the public programmatic audit API without new audit
  logic. It exposes `audit_codebase` (path, json-or-summary format, and
  changed/base passthrough mirroring the CLI flags) plus
  `describe_capabilities` registry metadata, bounds oversized responses at
  roughly 50 KB with an explicit note, and never grants `--run-checks`
  validation commands or live database access.
- Add the `--require-complete` scan and audit option: exits with code 2 when any
  audit domain coverage is incomplete, so partial or unsupported coverage is
  never reported as a clean result.
- Add a composite GitHub Action (`action.yml`) and
  [docs/github-action.md](docs/github-action.md) that install the published CLI,
  run a scan, write text, JSON, or SARIF output, and fail the job according to
  `fail-on` and `require-complete`.

### Security

- Keep raw SQL, source expressions, Date values, and secrets out of findings,
  fingerprints, and every reporter. The module provides external-only typed
  comparison or explicit-encoder guidance and never applies a repair. Static
  safety proof is limited to a fresh inline, spread-free encoder object with a
  callable `mapToDriverValue`; identifiers, aliases, members, calls, and other
  encoder arguments remain partial coverage rather than assumed safety.

## [0.1.6] - 2026-07-18

### Changed

- Treat workspace publication entries, generated targets, and fixture-controlled
  paths as source-integrity coverage limitations unless independent evidence
  proves a missing target.
- Respect governing pnpm, Yarn, and Bun ownership instead of emitting npm-only
  dependency findings, including inherited workspace ownership.
- Bound repeated schema-1 coverage and limitation evidence while preserving exact
  total, emitted, and omitted counts plus deterministic samples.
- Reuse the immutable source-resolution index across graph edges to reduce audit
  time without changing findings, coverage, or impact semantics.

### Security

- Suppress a repository-shareable private test key only when offline
  cryptographic comparison matches an inventoried certificate whose identities
  are exclusively localhost or loopback. Unmatched keys remain high severity.

## [0.1.5] - 2026-07-18

### Added

- Add the capability-free, read-only, offline `repository/source-integrity`
  Doctor and its precision-first `source/import-target-missing` rule. It reports
  only provably missing explicit supported relative files, single deterministic
  alias targets, and unique-workspace explicit entries while keeping uncertain
  resolution as coverage limitations.

### Changed

- Select changed source-integrity work from changed importers plus complete
  reverse-impacted importers, including unchanged importers whose explicit
  target was deleted or renamed. Bound findings to 1,000 and report truncation
  or upstream graph limitations as partial coverage.

### Security

- Keep `repository/source-graph` finding-free, withhold raw import specifiers
  and source text from the new findings and fingerprints, and preserve the
  permanent external-remediation boundary. This behavior first ships in
  `0.1.5`; it was not part of the published `0.1.4` package.

## [0.1.4] - 2026-07-18

### Added

- Add a bounded, read-only, offline `repository/source-graph` Doctor for
  JavaScript and TypeScript. It parses static import, re-export, type-only,
  literal `require`, and literal dynamic-import topology without executing
  source, then exposes optional schema-1 `sourceImpact` counts, coverage,
  shortest changed-impact paths, impacted projects, and bounded records.
- Add a deterministic `domainCoverage` inventory for all nine audit domains,
  separating applicability from status and preserving module details, evidence,
  limitations, and conservative `coverageComplete` semantics across text, JSON,
  SARIF, and the public package contract. Complete coverage describes declared
  audit execution; it is not proof that code is bug-free or correct.
- Add an automatic, read-only, offline `security/secrets` Doctor for
  repository-shareable files. It distinguishes tracked credentials from ignored
  local `.env` storage, uses precision-first provider/context detection, withholds
  values from every report and fingerprint, bounds total work and findings, and
  reports incomplete work as partial coverage.
- Add an automatic, offline, read-only `security/dependencies` Doctor for npm
  lockfile versions 2 and 3. It reports high-confidence lock presence, drift,
  insecure transport, mutable Git, integrity, workspace resolution, and
  competing-lock evidence without invoking a package manager, using the
  network, exposing raw source values, claiming CVE coverage, or changing the
  target repository. Unsupported ecosystems and incomplete work remain visible
  in module and security-domain coverage.

### Changed

- Extend changed-scope planning with conservative `source-dependent` projects
  derived from internal source edges while preserving full counts and explicit
  graph limitations.
- Align current and historical product documentation around one unified auditor
  with built-in domain modules, and remove executable direction for the rejected
  external-Doctor architecture.
- Distinguish implemented `0.1.4` analysis from the full-codebase north star so a
  full requested scope is not mistaken for complete analyzer coverage across
  every language, framework, and domain.

### Security

- Withhold raw import specifiers and source text from source-graph reports and
  fingerprints. The parser loads no repository plugins, makes no network
  requests, performs no writes, and treats dynamic, ambiguous, unsupported, or
  ceiling-limited topology as coverage limitations rather than findings.
- Exclude local private planning material from the Git index and npm package,
  narrow the public documentation package whitelist, and enforce the package
  boundary during tarball verification.

## [0.1.3] - 2026-07-17

### Changed

- Establish the permanent product boundary: **Models build. Codebase Doctor
  verifies.** A human or separately authorized external coding agent performs
  changes; Codebase Doctor supplies remediation guidance and independently
  verifies the result.
- Remove direct filesystem-write and remediation authority from the Doctor
  capability contract. Separately approved repository-owned validation
  subprocesses remain non-isolated and distinct from Doctor repair authority.
- Add full and Git-aware changed audit scopes. Changed audits select directly
  affected projects, conservative internal workspace dependants, affected check
  plans, and complete relevant SQL migration streams while reporting explicit
  reasons and limitations.
- Suppress resolved-baseline claims for changed audits; only comparable full
  audits report absent baseline findings as resolved.

### Added

- Automatically audit supported PostgreSQL RLS migration streams from
  Supabase, Prisma, Drizzle, and generic migration layouts without credentials
  or network access.
- Reconstruct supported final table, policy, RLS, FORCE RLS, grant, and revoke
  state with real SQL file evidence and stable `database/sql-rls/*` findings.
- Add optional schema-1 coverage records to text, JSON, and SARIF so completed,
  partial, not-applicable, skipped, and failed audit scope remains explicit.
- Export the `AuditCoverage` and `CoverageStatus` programmatic types.
- Export changed-scope discovery, planning, report, and baseline comparison
  contracts, including `DetectedProject` and `GitScopeErrorCode`, from the
  package entry point without exporting Git runner injection or execution
  internals.
- Add model-facing `impact`, `remediationConstraints`, and `verification`
  guidance to findings without changing fingerprint identity.

### Security

- Guarantee that Codebase Doctor has no direct target-file write API, direct
  filesystem-write capability, remediation executor, or direct repair authority.
  Approved repository-owned validation subprocesses remain explicitly
  permissioned and documented as unsandboxed in the current release line.
- Read only SQL paths admitted by bounded repository inventory, enforce a
  per-file size ceiling, and never execute or evaluate migration SQL.
- Mark dynamic, malformed, or unsupported relevant SQL as partial coverage
  instead of guessing database state.
- Keep Git discovery fixed and read-only. `--changed` does not grant subprocess,
  network, or database permission and never grants direct Doctor target-write
  authority.

## [0.1.2] - 2026-07-15

### Added

- Introduce `codebase-doctor audit` as the unified full-codebase command while
  retaining `scan` as the backward-compatible repository-only interface.
- Add a built-in PostgreSQL Row Level Security audit module migrated from RLS
  Doctor's catalog loader, analyzer, role graph, and policy rules.
- Add separately permissioned live database auditing through `--with-database`,
  repeatable `--database-schema`, and bounded `--database-timeout` options.
- Normalize database findings into the shared text, JSON schema 1, SARIF,
  fingerprint, baseline, severity, remediation, and exit-code contracts.
- Export the programmatic `auditCodebase` API and `AuditRequest` type.
- Report database coverage as skipped, completed, or failed so agents cannot
  confuse an unaudited database with a clean database.
- Add disposable PostgreSQL 16 integration coverage for unsafe and safe RLS
  fixtures, credential redaction, and clean npm tarball installation.
- Preview validation command plans during read-only scans.
- Configure repository-relative exclusions through `.codebase-doctor.json` and
  repeatable `--exclude` options.
- Compare findings with schema-1 JSON baselines and apply failure thresholds only
  to new findings.
- Emit deterministic SARIF 2.1.0 reports with locations, rule metadata,
  fingerprints, evidence, and baseline state.
- Select text, JSON, or SARIF with `--format` while preserving `--json`.

### Security

- Keep PostgreSQL credentials in environment variables, sanitize connection
  failures, use read-only repeatable-read catalog transactions, and never
  execute suggested SQL.
- Override esbuild to `0.28.1` or newer to resolve
  `GHSA-g7r4-m6w7-qqqr` in the development toolchain.

## [0.1.1] - 2026-07-15

### Added

- Show live monthly npm downloads in the repository and package README.

### Fixed

- Correct the README status and usage wording after the initial npm publication.

## [0.1.0] - 2026-07-15

### Added

- Read-only, bounded, symlink-safe repository inventory.
- Node.js, JavaScript, TypeScript, Python, Go, Rust, and Java project detection.
- React, Next.js, Vite, and NestJS framework signals.
- npm, pnpm, Yarn, Bun, uv, and Poetry evidence detection.
- Exact and one-level package workspace discovery.
- Project Doctor findings for invalid manifests, conflicting lockfiles, missing workspaces, and absent visible tests.
- Opt-in JavaScript/TypeScript and Python validation checks.
- Shell-free subprocess execution with time, output, environment, and redaction controls.
- Deterministic text reports and JSON schema version `1`.
- Severity thresholds with process exit codes `0`, `1`, and `2`.
- Provider-neutral Codebase Doctor agent skill.
- Locked GitHub Actions CI and clean-install npm tarball verification.

### Fixed

- Resolve npm `.bin` symlinks before deciding whether the CLI is the entrypoint.
- Ignore `.venv-*` directories so named local virtual environments do not become detected Python projects.

### Limitations

- Go, Rust, and Java are detection-only.
- Approved child commands are not network-isolated.
- Python tool planning uses visible tests and dedicated pytest, Ruff, or mypy configuration evidence; Codebase Doctor does not fully parse TOML in this release.
- Workspace expansion supports exact paths and one-level `directory/*` patterns.
- Codebase Doctor coordinates deterministic evidence and configured tools; it cannot detect every software defect.
