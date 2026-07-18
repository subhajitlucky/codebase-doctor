# Changelog

All notable changes to Codebase Doctor are documented here.

## [Unreleased]

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
