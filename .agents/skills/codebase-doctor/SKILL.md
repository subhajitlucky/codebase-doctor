---
name: codebase-doctor
description: Run evidence-backed, model-independent repository diagnostics with the Codebase Doctor CLI. Use when inspecting a codebase, validating agent-written changes, reviewing configured checks, or interpreting scan findings and exit codes.
---

# Codebase Doctor

Use the CLI as a verification layer after code changes. Treat findings as evidence from repository structure or configured tools, not as proof that the tool can detect every defect.

## Workflow

1. Run read-only discovery first:

   ```bash
   npx codebase-doctor scan . --json
   ```

2. Review detected projects, `plannedChecks`, structured findings, and the declared validation commands that form the command plan. The plan is visible without process execution.
3. Confirm explicit execution permission before adding `--run-checks`. Do not use `--run-checks` on an untrusted repository; approved child commands are not network-isolated in version 0.1.
4. When permission is confirmed, run:

   ```bash
   npx codebase-doctor scan . --run-checks --json
   ```

5. Fix one evidence-backed finding at a time. Do not invent a defect from an informational signal.
6. Rerun the exact scan after each change and compare rule IDs, fingerprints, evidence, and severity totals.

Use `--exclude` or `.codebase-doctor.json` to omit intentional fixtures and unrelated generated projects. Use `--baseline` with a prior JSON report when only new findings should affect the threshold. Use `--format sarif` for SARIF 2.1.0 consumers; `--json` remains the schema-1 JSON shortcut.

Use `--timeout` only to set the per-command time limit. Use `--fail-on` only to change the finding threshold used for the process exit status.

## Interpret results

- Exit `0`: the scan completed and no finding met the configured threshold.
- Exit `1`: the scan completed and at least one finding met the configured threshold.
- Exit `2`: the CLI could not perform the requested scan because of invalid input or an operational failure. Never treat exit `2` as clean.

Keep operational failures separate from code findings. Preserve redacted evidence when reporting results, and request user direction when execution permission or repository trust is unclear.
