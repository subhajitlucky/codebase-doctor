# Changelog

All notable changes to Codebase Doctor are documented here.

## [Unreleased]

### Added

- Automatically audit supported PostgreSQL RLS migration streams from
  Supabase, Prisma, Drizzle, and generic migration layouts without credentials
  or network access.
- Reconstruct supported final table, policy, RLS, FORCE RLS, grant, and revoke
  state with real SQL file evidence and stable `database/sql-rls/*` findings.
- Add optional schema-1 coverage records to text, JSON, and SARIF so completed,
  partial, not-applicable, skipped, and failed audit scope remains explicit.
- Export the `AuditCoverage` and `CoverageStatus` programmatic types.

### Security

- Read only SQL paths admitted by bounded repository inventory, enforce a
  per-file size ceiling, and never execute or evaluate migration SQL.
- Mark dynamic, malformed, or unsupported relevant SQL as partial coverage
  instead of guessing database state.

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
