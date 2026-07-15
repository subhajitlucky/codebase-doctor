# Changelog

All notable changes to Codebase Doctor are documented here.

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
