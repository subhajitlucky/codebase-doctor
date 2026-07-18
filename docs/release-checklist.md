# Codebase Doctor Release Checklist

Use this checklist from a clean release-candidate commit. Do not publish or
create a remote tag without explicit human approval.

Permanent release invariant: **Models build. Codebase Doctor verifies.**
Codebase Doctor has no direct target-file write API, filesystem-write
capability, remediation executor, or direct repair authority. A human or
separately authorized external coding agent performs fixes, and Codebase Doctor
independently verifies the resulting state. Separately approved repository-owned
validation subprocesses remain unsandboxed and may have side effects.

## Validated locally

- [x] Read-only scan: Codebase Doctor repository
- [x] Read-only scan: RLS Doctor TypeScript/npm repository
- [x] Read-only scan: MIHA pnpm monorepo
- [x] Read-only scan: Sutra Python repository
- [x] Target Git status unchanged before and after every scan
- [x] MIHA `.venv-*` false positive captured as a regression test and corrected
- [x] `codebase-doctor@0.1.3` was published on 2026-07-17; recheck the live package immediately before publication

## Before publication

- [ ] Confirm source, tests, package docs, and skills contain no target-write or
  executable-repair capability.
- [ ] Confirm npm authentication with `npm whoami`.
- [ ] Confirm npm account two-factor authentication policy.
- [ ] Confirm the live npm package is still at the expected prior version.
- [ ] Confirm `git status --short` is empty.
- [ ] Run `npm ci`.
- [ ] Run `npm run ci:full`.
- [ ] Run `CODEBASE_DOCTOR_ALLOW_DESTRUCTIVE_TESTS=1 npm run test:rls-integration` against its disposable Docker database.
- [ ] Run `npm pack --dry-run` and review the summary.
- [ ] Create the real tarball and review every included path.
- [ ] Review README commands, exit codes, safety warnings, and shipped-versus-roadmap wording.
- [ ] Confirm `package.json`, CLI `--version`, changelog, Git tag, and release title all use the approved version.
- [ ] Confirm `audit --help` documents database permission without accepting a connection-string option.
- [ ] Confirm unsafe and safe RLS fixtures produce the expected unified results and no credential output.
- [ ] Run `npm publish --dry-run`.
- [ ] Obtain explicit human approval before `npm publish --access public`.

## After approved publication

- [ ] Create and push the approved `v0.1.4` tag only after publication authorization.
- [ ] Run the published package's `--version` in a clean temporary directory.
- [ ] Run a read-only `codebase-doctor audit . --json` smoke test and inspect skipped coverage.
- [ ] Confirm the npm package page shows the expected README, license, files, and version.
