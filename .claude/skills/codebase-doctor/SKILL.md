---
name: codebase-doctor
description: Audit a repository and return evidence-backed findings. Use when asked what breaks if I change a file, whether a codebase is safe to ship, to verify agent-written changes, to find secrets or dependency risks, or to review coverage and limitations after an audit. Also use for SARIF or JSON code audits, impact analysis after a rename or delete, and baseline-based CI review gates.
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

## When to use this

Answer yes to any of these and this skill applies:

- "What breaks if I change this file?" or "what imports this?"
- "Is this repo safe to ship?" / "audit this before I merge"
- "I just changed a lot — verify the result"
- "Find secrets in the working tree or git history"
- "Check dependencies for known advisories"
- "Is my Dockerfile / GitHub Actions workflow risky?"
- "Give me SARIF for GitHub code scanning"
- "Why is this finding here, and how do I fix it?"

Do not use this skill when the task is a code edit, a style rewrite, or a
feature build. Codebase Doctor reports; it does not repair.

## Workflow

1. After edits, run the default changed audit with the trusted installed binary:

   ```bash
   codebase-doctor audit . --changed --format brief
   ```

2. At trust or release boundaries, run the full audit:

   ```bash
   codebase-doctor audit .
   ```

3. Read `domainCoverage` before summarizing. State which domains completed,
   which are partial, and which are not implemented.

4. For every finding you act on, fix it outside this tool, then rerun the
   matching command to confirm the fingerprint is gone.

5. To gate CI on new problems only, write a baseline once and verify against it:

   ```bash
   codebase-doctor audit . --json > baseline.json
   codebase-doctor verify . --baseline baseline.json
   ```

## MCP

If the MCP server is registered, prefer its tools over shell calls. It never
enables `--run-checks` or live database access:

- `audit_codebase` — full report
- `verify_changes` — compare against a baseline
- `explain_finding` — one finding in detail
- `describe_capabilities` — current coverage map

## Safety

- Never treat a clean report as proof the code is correct.
- Surface every `Limitation` line to the user. Do not summarize them away.
- Suggested repair steps are guidance. Do not execute them automatically.

## References

- `README.md`
- `docs/architecture.md`
