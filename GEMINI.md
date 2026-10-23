# GEMINI.md — Codebase Doctor

Models build. Codebase Doctor verifies. Codebase Doctor audits repositories
and returns deterministic, evidence-backed findings. It never edits files,
runs repository checks, or connects to a database through the MCP server.

## Use it when

- asked what breaks if a file changes (blast radius)
- asked to audit a repo, or whether it is safe to ship
- asked to verify agent-written changes or a diff before merge
- scanning for committed secrets, dependency drift, or risky CI/Docker config
- producing SARIF, HTML, or a PR-review verdict

## How to run it

```bash
codebase-doctor audit . --changed --format brief   # after edits
codebase-doctor audit .                            # full audit
codebase-doctor review . --base main --format markdown
```

MCP: `gemini mcp add codebase-doctor npx -y codebase-doctor@0.5.0 mcp`
Tools: `audit_codebase`, `review_changes`, `verify_changes`,
`explain_finding`, `verify_intent`, `build_receipt`,
`describe_capabilities`. Call `describe_capabilities` first; errors return
`{ error: { code, message, nextAction } }`.

## Hard rules

- Never claim a repo is "verified" or "clean" without listing coverage limits.
- Never hide `domainCoverage` limitations from the user.
- After a fix, rerun the matching command and confirm the fingerprint is gone.
- Exit codes: `0` clean, `1` findings at/above the threshold, `2` operational failure (never clean).

Full agent notes live in [AGENTS.md](AGENTS.md); per-client setup in
[docs/agents.md](docs/agents.md).
