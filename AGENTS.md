# Codebase Doctor — agent notes

One unified repository auditor. Models build; Codebase Doctor verifies.

## Trigger phrases

- what breaks if I change this file
- audit this repo / is this safe to ship
- verify my changes / verify agent-written code
- find secrets / check dependencies
- what is my blast radius
- SARIF report
- why is this finding here

## Quick start

```bash
npx codebase-doctor audit . --changed --format brief   # after edits
npx codebase-doctor audit .                            # full audit
```

## Tools

```bash
codebase-doctor audit [path]     # full built-in audit
codebase-doctor scan [path]      # repository-only scan (back-compat)
codebase-doctor mcp              # serve read-only tools over stdio
```

MCP tools: `audit_codebase`, `verify_changes`, `explain_finding`, `describe_capabilities`.

## Hard rules for agents

- Do not use this tool to edit files. It has no write API and will not repair.
- Do not hide `domainCoverage` limitations from the user.
- After a fix, rerun the matching command and confirm the fingerprint is gone.
- Never claim a codebase is "verified" or "clean" without listing coverage limits.

## Coverage limits

Reflection, runtime/DI wiring, generated sources, and cross-language process edges are not source edges. The report marks these as dynamic boundaries or limitations.

## Links

- npm: https://www.npmjs.com/package/codebase-doctor
- Post: https://subhajitpradhan.vercel.app/writing/what-breaks-if-i-change-this-file
