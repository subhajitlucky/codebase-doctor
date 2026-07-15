# Codebase Doctor 0.1.0 Release Checklist

Use this checklist from a clean `0.1.0` release-candidate commit. Do not publish or create a remote tag without explicit human approval.

## Validated locally

- [x] Read-only scan: Codebase Doctor repository
- [x] Read-only scan: RLS Doctor TypeScript/npm repository
- [x] Read-only scan: MIHA pnpm monorepo
- [x] Read-only scan: Sutra Python repository
- [x] Target Git status unchanged before and after every scan
- [x] MIHA `.venv-*` false positive captured as a regression test and corrected
- [x] npm registry returned `E404` for `codebase-doctor` on 2026-07-15; recheck immediately before publication

## Before publication

- [ ] Confirm npm authentication with `npm whoami`.
- [ ] Confirm npm account two-factor authentication policy.
- [ ] Recheck live `codebase-doctor` name availability.
- [ ] Confirm `git status --short` is empty.
- [ ] Run `npm ci`.
- [ ] Run `npm run ci:full`.
- [ ] Run `npm pack --dry-run` and review the summary.
- [ ] Create the real tarball and review every included path.
- [ ] Review README commands, exit codes, safety warnings, and shipped-versus-roadmap wording.
- [ ] Confirm `package.json`, CLI `--version`, changelog, Git tag, and release title all use `0.1.0`.
- [ ] Run `npm publish --dry-run`.
- [ ] Obtain explicit human approval before `npm publish --access public`.

## After approved publication

- [ ] Create and push the approved `v0.1.0` tag only after publication authorization.
- [ ] Run `npx codebase-doctor@0.1.0 --version` in a clean temporary directory.
- [ ] Run a read-only `npx codebase-doctor@0.1.0 scan . --json` smoke test.
- [ ] Confirm the npm package page shows the expected README, license, files, and version.
