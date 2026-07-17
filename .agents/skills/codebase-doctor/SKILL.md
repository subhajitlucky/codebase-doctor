---
name: codebase-doctor
description: Run evidence-backed, model-independent codebase diagnostics with the Codebase Doctor CLI. Use when auditing a repository, validating agent-written changes, reviewing configured checks, or interpreting findings and coverage.
---

# Codebase Doctor

Use Codebase Doctor as an independent verification layer. Prefer a changed
audit after edits and a full audit at trust or release boundaries.

> **Models build. Codebase Doctor verifies.**

Codebase Doctor exposes no direct target-file write API, has no direct
filesystem-write capability, and includes no remediation executor. It can never
be granted direct target-write or remediation authority. Remediation and
verification commands are guidance, not executable repairs. A human or
separately authorized external coding agent performs the fix; Codebase Doctor
reruns independently.

Use a trusted, already-installed `codebase-doctor` binary, or the explicit local
`./node_modules/.bin/codebase-doctor` binary. Package acquisition or package
update is a separate, pinned, user-authorized step that may use the network and
perform cache writes. Do not use an on-demand package runner as the audit step.

## Workflow

1. After edits, run the default changed audit with the trusted installed binary:

   ```bash
   codebase-doctor audit . --changed --json
   ```

   This default compares with `HEAD` and includes staged, unstaged, and
   untracked paths. For branch review, provide the required ref value:

   ```bash
   codebase-doctor audit . --changed --base main --json
   ```

   `--base` is optional as a changed-audit mode. If `--base` is present, a
   missing operand or invalid ref is an operational exit `2`. An explicit ref
   uses its merge base and includes committed branch changes plus staged,
   unstaged, and untracked worktree changes. Git commands are fixed and
   read-only.

2. At a trust, integration, or release boundary, run the full audit:

   ```bash
   codebase-doctor audit . --json
   ```

3. Inspect `auditScope`, then `doctorRuns`, then `coverage`, then `findings`.
   Changed mode is mixed-scope, not a universal file filter. Project Doctor
   structural rules run with the full repository snapshot and may report
   findings outside changed paths or projects for manifests, lockfiles,
   workspaces, and test visibility. Configured validation command plans are
   built from the full topology and then filtered to `affectedProjectIds`.
   Static SQL selects affected migration streams and replays full current
   history for every selected stream, with partial or skipped topology
   limitations. Live database remains a full observed schema-set audit only
   when separately requested with `--with-database`.

   Unaffected source behavior and domain checks are not broadly covered, while
   full-context structural doctors may inspect unaffected areas. Never treat
   zero changed findings as a full repository clean result. Read every partial,
   skipped, failed, and limitation record to understand each doctor's scope.

4. Read each finding's evidence and machine-readable `impact`,
   `remediationConstraints`, and `verification` guidance. Expected repair
   requires the fingerprint to be absent on rerun and all applicable coverage
   to be completed. Do not claim a finding resolved outside coverage. A changed
   baseline comparison never calls absent baseline findings resolved; a
   comparable full audit can.

5. Ask a human or external coding agent to fix one evidence-backed finding.
   Then rerun the same scope and compare fingerprints, evidence, coverage, and
   severity totals. Codebase Doctor does not execute remediation or verification.

6. Request separate permission before adding `--run-checks`:

   ```bash
   codebase-doctor audit . --changed --run-checks --json
   ```

   `--changed` alone grants no command execution, network, or database
   permission and no direct Doctor target-write authority. Separately authorized
   `--run-checks` launches repository-owned validation subprocesses. They are
   not filesystem- or network-isolated and may have side effects. That
   permission is validation execution, not Doctor repair authority. Do not use
   `--run-checks` on an untrusted repository.

7. Static `database/sql-rls` coverage runs automatically and offline for
   supported migration streams. It reports expected migration state, never
   executes SQL, and may be partial for dynamic, malformed, or unsupported SQL.
   Partial coverage is not clean. Live `database/rls` reports observed catalog
   state and requires separate database and network permission:

   ```bash
   codebase-doctor audit . --with-database --json
   ```

   Supply credentials through `DATABASE_URL` or `SUPABASE_DB_URL`; never print,
   echo, log, or expose a credential or connection string. Use
   `--database-schema` repeatedly for non-default schemas and
   `--database-timeout` to change the catalog statement timeout. A skipped or
   failed live doctor is not a clean database audit.

`scan` is the backward-compatible repository-only command. Use `--exclude` or
`.codebase-doctor.json` for intentional exclusions, `--baseline` to classify
fingerprints, `--format sarif` for SARIF 2.1.0, `--timeout` for configured check
limits, and `--fail-on` only for finding-based process status.

## Interpret results

- Exit `0`: requested audits completed and no finding met the threshold. This
  does not override partial, skipped, limited, or changed-only coverage.
- Exit `1`: requested audits completed and a finding met the threshold.
- Exit `2`: invalid input or an operational failure prevented a requested
  audit. Never treat exit `2` as clean.

Keep operational failures separate from findings and preserve redacted evidence.
Request user direction whenever repository trust, check execution, or live
database access is unclear.
