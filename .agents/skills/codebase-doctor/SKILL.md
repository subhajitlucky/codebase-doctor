---
name: codebase-doctor
description: Run evidence-backed, model-independent codebase diagnostics with the Codebase Doctor CLI. Use when auditing a repository, validating agent-written changes, reviewing configured checks, or interpreting findings and coverage.
---

# Codebase Doctor

Use Codebase Doctor as one unified full-codebase auditor and independent
verification layer. Domain knowledge lives in built-in internal audit modules,
not separately installed Doctor products. Prefer a changed audit after edits
and a full audit at trust or release boundaries.

> **Models build. Codebase Doctor verifies.**

Codebase Doctor exposes no direct target-file write API, has no direct
filesystem-write capability, and includes no remediation executor. It can never
be granted direct target-write or remediation authority. Remediation and
verification commands are guidance, not executable repairs. A human or
separately authorized external coding agent performs the fix; Codebase Doctor
reruns independently.

A full audit examines the full requested repository scope for applicable
implemented modules. It does not mean complete analyzer coverage for every
domain. Every report includes `domainCoverage`, a fixed checklist of all nine
domains. It separates applicability from status and preserves evidence,
limitations, and module-level status. `coverageComplete` means only that the
declared applicable, selected analysis completed, or that non-applicability was
justified. `coverageComplete` does not mean the code is bug-free or correct.
Inspect the complete inventory before calling a codebase verified or clean.

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

3. Inspect `auditScope`, then `domainCoverage`, then `doctorRuns`, then
   low-level `coverage`, then `findings`. For every domain, read applicability
   separately from status and inspect its module details, evidence, and
   limitations. `unsupported`, `unknown`, and `not-selected` are explicit gaps,
   not successful audits.

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

4. Inspect the optional schema-1 `sourceImpact` object and
   `repository/source-graph` coverage. This read-only, offline JavaScript and
   TypeScript graph recognizes static import, re-export, type-only import,
   literal require, and literal dynamic import edges with a real syntax parser
   that never executes repository code. Local `tsconfig` and `jsconfig` files
   supply a deterministic subset of aliases; this is not complete Node or
   TypeScript resolution.

   Changed impact adds `source-dependent` projects and shows a deterministic
   shortest impact path for each serialized dependant. It preserves full
   impacted-file counts while emitting bounded records. Dynamic, ambiguous,
   unsupported, unreadable, or ceiling-limited topology is a coverage
   limitation, not a finding; cycles are not findings. Inspect source graph
   coverage before calling changed source scope clean or verified. Source
   impact does not prove code is bug-free, correct, or completely reachable.
   Raw import specifiers and source text are withheld from reports and
   fingerprints. The graph uses no plugins, network requests, or writes.

5. Read each finding's evidence and machine-readable `impact`,
   `remediationConstraints`, and `verification` guidance. Expected repair
   requires the fingerprint to be absent on rerun and all applicable coverage
   to be completed. Do not claim a finding resolved outside coverage. A changed
   baseline comparison never calls absent baseline findings resolved; a
   comparable full audit can.

6. Ask a human or external coding agent to fix one evidence-backed finding.
   Then rerun the same scope and compare fingerprints, evidence, coverage, and
   severity totals. Codebase Doctor does not execute remediation or verification.

7. Request separate permission before adding `--run-checks`:

   ```bash
   codebase-doctor audit . --changed --run-checks --json
   ```

   `--changed` alone grants no command execution, network, or database
   permission and no direct Doctor target-write authority. Separately authorized
   `--run-checks` launches repository-owned validation subprocesses. They are
   not filesystem- or network-isolated and may have side effects. That
   permission is validation execution, not Doctor repair authority. Do not use
   `--run-checks` on an untrusted repository.

8. Static `database/sql-rls` coverage runs automatically and offline for
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

9. The combined audit automatically runs the read-only, offline
   `security/secrets` module. It is precision-first and not exhaustive. A
   Git-ignored local `.env` file is normal and is not a finding; a tracked
   `.env`, template, source file, or other repository-shareable file containing
   a real credential is a finding. Changed mode scans only current changed
   files.

   The matched value is withheld and never enters a fingerprint, message,
   evidence record, error, text, JSON, or SARIF output. Never ask Doctor to show
   or validate it. Treat partial, failed, or not-selected secrets coverage as an
   unresolved verification gap. Have an external authorized human or coding
   agent remediate the shareable content, rotate or revoke the credential
   outside Codebase Doctor, and then rerun the same audit. Doctor never performs
   those actions.

10. The combined audit also automatically runs the read-only, offline
   `security/dependencies` module for npm lockfile versions 2 and 3. pnpm, Yarn,
   Bun, Python, and other ecosystems remain explicit unsupported coverage for
   this module. It never invokes npm or another package manager, runs a shell or
   lifecycle script, uses the network, installs packages, or changes dependency
   metadata.

   Its rules are `missing-lockfile`, `manifest-lock-drift`, `insecure-source`,
   `mutable-git-source`, `missing-integrity`,
   `workspace-registry-resolution`, and `competing-npm-lockfiles`. A normal
   semver range is not a finding when supported lock metadata agrees. This
   offline module makes no CVE or current advisory claim.

   Raw dependency specifications and resolved URLs are withheld and never enter
   a fingerprint, finding, evidence record, limitation, error, text, JSON, or
   SARIF output. Never ask Doctor to reveal a source value. Read completed,
   partial, unsupported, failed, and not-selected dependency coverage before
   calling a graph clean. Have an external authorized human or coding agent
   correct the metadata and rerun the same scope; Doctor never performs that
   remediation.

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
