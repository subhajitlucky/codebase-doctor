# codebase-doctor with coding agents

Every codebase-doctor MCP tool is read-only, offline, and annotated
`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
`openWorldHint: false`. The server never enables `--run-checks` validation
commands, live database access, or network advisory lookups; run the CLI
explicitly to grant those separately. Failures return
`{ error: { code, message, nextAction } }` with `code` one of
`invalid-arguments`, `path-not-found`, `path-access-denied`, `unknown-tool`,
`internal-error`.

Pin the version (`@0.5.0` below) to the release you audited; tool schemas
move with server versions. `initialize` reports the exact server version.

## Claude Code

```bash
claude mcp add codebase-doctor --scope user -- npx -y codebase-doctor@0.5.0 mcp
```

Auto-approve the read-only tools in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__codebase-doctor__describe_capabilities",
      "mcp__codebase-doctor__audit_codebase",
      "mcp__codebase-doctor__review_changes",
      "mcp__codebase-doctor__verify_changes",
      "mcp__codebase-doctor__explain_finding",
      "mcp__codebase-doctor__verify_intent",
      "mcp__codebase-doctor__build_receipt"
    ]
  }
}
```

The agent skill is also installable: `npx skills add subhajitlucky/codebase-doctor`.

## Codex CLI

```bash
codex mcp add codebase-doctor -- npx -y codebase-doctor@0.5.0 mcp
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.codebase-doctor]
command = "npx"
args = ["-y", "codebase-doctor@0.5.0", "mcp"]
```

Codex reads [AGENTS.md](AGENTS.md) for repo context.

## Gemini CLI

```bash
gemini mcp add codebase-doctor npx -y codebase-doctor@0.5.0 mcp
```

Equivalent `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "codebase-doctor": {
      "command": "npx",
      "args": ["-y", "codebase-doctor@0.5.0", "mcp"]
    }
  }
}
```

Gemini CLI reads [GEMINI.md](GEMINI.md) for project context.

## Any other stdio MCP client (GLM, Kimi, Grok, …)

If the client speaks stdio MCP — directly or through a Claude
Code-compatible harness — this config works as-is:

```json
{
  "mcpServers": {
    "codebase-doctor": {
      "command": "npx",
      "args": ["-y", "codebase-doctor@0.5.0", "mcp"]
    }
  }
}
```

## Expected agent loop

1. `audit_codebase` with `changed: true` after edits (or `review_changes`
   for a diff-narrowed PR verdict).
2. Fix findings with a human or external agent; Codebase Doctor never writes.
3. `verify_changes` with the saved baseline; a finding counts as resolved
   only when it is absent under completed coverage.
4. `explain_finding` for full evidence and remediation guidance on anything
   ambiguous.

Zero findings under partial, skipped, or not-selected coverage is not a clean
result — say so.
