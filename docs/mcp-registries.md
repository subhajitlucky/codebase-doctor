# MCP registry publishing

Codebase Doctor ships the metadata every registry needs. Publishing itself
requires the maintainer's credentials, so this page lists the exact commands;
no repository change is needed beyond keeping `server.json` and `package.json`
in sync (enforced by `test/unit/packaging/registry-metadata.test.ts`).

Repository facts used below:

- npm package: `codebase-doctor` (public, `https://registry.npmjs.org`)
- Registry name: `io.github.subhajitlucky/codebase-doctor`
- Transport: stdio via `npx -y codebase-doctor mcp` (no environment variables,
  no network access, no writes)

## Official MCP registry (registry.modelcontextprotocol.io)

Prerequisites: the npm version being published is already public, and
`package.json` carries the matching `mcpName`.

```bash
npm install -g mcp-publisher@latest
mcp-publisher login github
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.subhajitlucky/codebase-doctor"
```

On version bumps, update `version` in both `package.json` and `server.json`
before publishing; the packaging test fails if they diverge.

## Smithery

Smithery publishes hosted URLs or `.mcpb` stdio bundles, not bare npm
packages, so listing here is a maintainer dashboard/CLI step rather than a
repository file:

```bash
npm install -g smithery@latest
smithery login
# Option A: dashboard import of the GitHub repository (recommended)
# Option B: publish a prepared stdio bundle
smithery mcp publish ./codebase-doctor.mcpb -n subhajitlucky/codebase-doctor
```

Keep the listing's install command as `npx -y codebase-doctor mcp` so clients
run the audited npm artifact with no extra services.

## Glama

Glama ingests the official registry automatically, so publishing there is the
primary step. Ownership claim uses the checked-in manifest:

1. `glama.json` at the repository root already names the maintainer account.
2. Submit the repository at `glama.ai/mcp/servers` (stdio type, GitHub URL).
3. Run the Claim ownership flow so rescans pick up manifest changes.

Glama verifies stdio servers from repository structure, package metadata, and
tool schemas. The server answers `initialize` and `tools/list` over stdio with
four read-only tools (`audit_codebase`, `verify_changes`, `explain_finding`,
`describe_capabilities`), each annotated `readOnlyHint: true`,
`destructiveHint: false`, `openWorldHint: false`.

## After publishing

- Link the listings from `README.md` so agents and humans can verify them.
- Re-verify after each minor release: search the registry API, confirm the
  Glama verified badge, and confirm the Smithery install command still
  resolves to the latest npm version.
