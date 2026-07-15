---
name: codebase-doctor
description: Run evidence-backed, model-independent codebase diagnostics with the Codebase Doctor CLI. Use when auditing a repository, validating agent-written changes, reviewing configured checks, or interpreting findings and coverage.
---

# Codebase Doctor

Use the unified CLI as a verification layer after code changes. Treat findings
as repository or database evidence, not as proof that every defect was found.

## Workflow

1. Start with the read-only unified audit:

   ```bash
   npx codebase-doctor audit . --json
   ```

2. Review detected projects, `plannedChecks`, findings, and every entry in
   `doctorRuns`. Without additional permission, configured checks and the
   database audit are reported as skipped. Skipped coverage is not a clean
   result for that audit area.
3. Confirm explicit permission before adding `--run-checks`. Do not use
   `--run-checks` on an untrusted repository; approved child commands are not
   network-isolated.
4. When command execution is approved, run:

   ```bash
   npx codebase-doctor audit . --run-checks --json
   ```

5. Request separate permission before adding `--with-database`. This performs a
   live, read-only PostgreSQL catalog audit and requires network access. Supply
   the connection through `DATABASE_URL` or `SUPABASE_DB_URL`; never print,
   echo, log, or expose the credential or connection string.
6. When database access is approved, run without putting the URL in arguments:

   ```bash
   npx codebase-doctor audit . --with-database --json
   ```

   Use `--database-schema` repeatedly for non-default schemas and
   `--database-timeout` only to change the catalog statement timeout.
7. Fix one evidence-backed finding at a time, then rerun the exact audit and
   compare rule IDs, fingerprints, evidence, coverage, and severity totals.

`scan` is the backward-compatible repository-only command. Prefer `audit` for
new agent workflows so internal audit modules share one report.

Use `--exclude` or `.codebase-doctor.json` to omit intentional fixtures and
generated projects. Use `--baseline` when only new findings should affect the
threshold. Use `--format sarif` for SARIF 2.1.0; `--json` remains the schema-1
JSON shortcut. Use `--timeout` for configured command time limits and
`--fail-on` only for finding-based process status.

## Interpret results

- Exit `0`: requested audits completed and no finding met the threshold; inspect
  skipped coverage separately.
- Exit `1`: requested audits completed and at least one finding met the
  threshold.
- Exit `2`: the CLI could not perform a requested audit because of invalid input
  or an operational failure. Never treat exit `2` as clean.

A failed database doctor run is not a clean database audit. Keep operational
failures separate from findings, preserve redacted evidence, and request user
direction whenever execution, database access, or repository trust is unclear.
