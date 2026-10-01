# Codebase Doctor

[![npm version](https://img.shields.io/npm/v/codebase-doctor.svg)](https://www.npmjs.com/package/codebase-doctor)
[![npm downloads](https://img.shields.io/npm/dm/codebase-doctor?label=npm%20downloads)](https://www.npmjs.com/package/codebase-doctor)
[![CI](https://github.com/subhajitlucky/codebase-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/subhajitlucky/codebase-doctor/actions/workflows/ci.yml)

**It finds the thing, and it never guesses.**

Most repository scanners fail in one of two ways: they flood you with false positives, or they silently skip the hard case and report "clean." Codebase Doctor does neither. Every finding carries evidence, every audit reports what it *couldn't* analyze, and a clean run means the scope was actually checked.

```bash
npx -y codebase-doctor audit . --changed --format brief
```

```txt
codebase-doctor brief
scope=full findings=1 shown=1 coverage=incomplete
[high] security/secrets/provider-token test/unit/audits/ai/agent-surface.test.ts:83 —
  Have an authorized human or external coding agent remove the value and rotate it,
  then rerun the audit.
coverage-limitations: validation: skipped, database: skipped, security: partial,
  performance: unsupported
```

That last line is the point. Most tools print findings and stop. This one tells you what it *didn't* check, every single run.

---

## Why this exists

Coding agents ship code faster than review can keep up. The failure isn't that agents can't write code — it's that nothing **verifies** what they wrote before it merges.

Codebase Doctor is that verification step. It builds a source graph, scans for committed secrets, dependency drift, unsafe Dockerfiles, workflow injection, RLS mistakes, and accessibility regressions — then tells you exactly what it could not verify.

## Install

```bash
npx -y codebase-doctor audit .          # no install
npm install -g codebase-doctor         # global
```

## Quick start

```bash
codebase-doctor audit . --json                   # full audit
codebase-doctor audit . --changed                # just my diff
codebase-doctor audit . --changed --base main    # PR review
codebase-doctor audit . --format sarif           # GitHub code scanning
codebase-doctor verify . --baseline before.json  # confirm fixes landed
```

![Codebase Doctor terminal preview](docs/assets/terminal-preview.svg)

## Options

```text
--run-checks          Permit configured validation commands
--changed             Audit Git changes and their affected scope
--base <ref>          Compare changed scope from the merge base with this ref
--json                Emit schema-versioned JSON
--format <format>     Output format: text, json, sarif, or brief
--exclude <glob>      Exclude a repository-relative path glob; repeatable
--baseline <path>     Compare with a prior Codebase Doctor JSON report
--timeout <ms>        Per-command timeout (default: 120000)
--fail-on <severity>  info|low|medium|high|critical|none (default: high)
--require-complete    Exit 2 when audit coverage is incomplete
--max-findings <n>    Cap brief output (default: 100)
--with-database       Permit live PostgreSQL catalog access
--with-advisories     Opt-in OSV advisory lookup over lockfile packages
--database-schema     Schema to inspect; repeatable (default: public)
--database-timeout    Catalog statement timeout in ms (default: 10000)
```

## GitHub Action

```yaml
permissions:
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@v4
  - uses: subhajitlucky/codebase-doctor@v0.1.9
    with:
      format: sarif
      upload: "true"
      fail-on: high
```

Findings appear in the Security tab. See [docs/github-action.md](docs/github-action.md).

---

## What it checks

### Secrets — working tree and history

Precision-first detection of private-key material, provider-token shapes, paired AWS credentials, credential-bearing URLs, and high-confidence sensitive assignments. A Git-ignored `.env` is normal storage and is **not** a finding; a tracked one containing a real credential is.

`security/secrets-history` catches the case that matters most: a secret committed and later deleted from the working tree, so a rotated-looking repo doesn't hide an exposure. It inspects the most recent 200 commits across all branches without ever checking out, rewriting, or executing repository content.

**Matched values are withheld from every finding, fingerprint, error, and report.** Codebase Doctor never prints your secrets — including in its own SARIF.

### Dependencies

Lockfile-aware for npm (v2/v3), pnpm (v5+), Yarn (classic and Berry), and Bun. Rule families cover missing lockfiles, manifest–lock drift, insecure or mutable Git sources, missing integrity hashes, and competing lockfiles.

A normal `^5.0.0` range is **not** a finding when the lock agrees. Unsupported ecosystems stay visible as coverage limits rather than guessed drift. It never invokes a package manager or touches your `node_modules`.

`--with-advisories` performs one bounded OSV lookup against resolved packages. Only names, versions, and ecosystems leave the machine.

### Source impact — what breaks if I change this file

A real syntax parser (never executes your code) builds a static import graph across **JS/TS, Python, Go, Java, and Rust**. In changed mode it walks reverse edges and reports a deterministic shortest impact path from each changed file.

```bash
codebase-doctor audit . --changed --base main
```

```txt
src/db/schema.ts → src/repositories/user.ts → src/api/users/[id]/route.ts
→ src/app/dashboard/page.tsx → tests/integration/user.test.ts
```

Cycles are valid topology, not findings. The graph module intentionally emits no bug findings — a separate precision-first `repository/source-integrity` module reports only *provably* missing import targets, so topology limits never become guessed bugs.

### Workflow and infrastructure

`script-injection` (attacker-controlled `${{ github.event.* }}` in a `run:` step), `pull-request-target-checkout`, `write-all-permissions`, unpinned action refs, unpinned Docker base images, `pipe-to-shell`, `root-user`, and world-writable files. Workflows are never dispatched and images are never built.

### PostgreSQL and Supabase RLS

Offline `database/sql-rls` reconstructs expected table, policy, RLS, and grant state from your migrations — no credentials, no network, never executes SQL. With `--with-database` it inspects live catalog state and can diff the two:

> your migrations say X, production says Y

reported as `table-missing-live`, `rls-disabled-live`, `policy-missing-live`, `grant-missing-live`, `rls-enabled-live-only`, `policy-unmanaged-live`, and more.

### Database and Drizzle hazards

The `database/drizzle` module catches a real runtime boundary where a JS `Date` interpolated into a raw `sql` template bypasses the column encoder:

```ts
// Before — throws ERR_INVALID_ARG_TYPE on postgres-js, works fine in psql
const rows = await db.execute(sql`select * from jobs where run_at <= ${date}`);

// After
const rows = await db.select().from(jobs).where(lte(jobs.runAt, date));
```

Applicability requires proven `drizzle-orm/postgres-js` usage. It reports only statically proven `Date` flows and never infers from a variable name.

### Agent surface — the newest attack target

Audits the agent configuration surface without executing or contacting any of it:

- MCP client configs: unpinned package runners, shell commands, inline credentials, broad filesystem grants
- `SKILL.md`: unscoped `allowed-tools` grants (`Bash(*)`, bare `Write`)
- Permission bypass: `bypassPermissions`, `--dangerously-skip-permissions`, `--yolo`, `yes-always`, broad `permissions.allow`

### Frontend

JSX/TSX and static HTML accessibility (`img-missing-alt`, `iframe-missing-title`, `html-missing-lang`, `positive-tabindex`) and static SEO (`missing-title`, `missing-meta-description`). No browser, no build.

---

## Coverage is reported, not assumed

This is the part most scanners skip.

Every report includes `domainCoverage` — a checklist of nine domains separating *not-applicable* from *detected-but-unsupported*, *skipped*, and *failed*. `coverageComplete` is true only when each applicable domain either completed or was justified as not applicable.

That means:

- **A clean run means the scope was actually checked.**
- `--require-complete` exits `2` rather than letting a skipped area report as clean.
- A truncated or bounded scan says so in `coverageSummary` with exact `total` / `emitted` / `omitted` counts and deterministic sample paths.

| Domain | Current coverage | North star |
| --- | --- | --- |
| Repository structure | Inventory, framework detection, manifests, workspaces, lockfiles, test visibility, JS/TS + Python + Go + Java + Rust impact graph | Cross-language dependency and behavioral topology |
| Configured validation | JS/TS and Python command planning; execution only with `--run-checks` | Sandboxed validation across ecosystems |
| Database | Offline migration RLS, Drizzle Date hazards, live RLS, static-to-live drift | Schemas, queries, permissions, more engines |
| Frontend | JSX/HTML a11y and static-HTML SEO | React, Next.js, bundle analysis, broader a11y |
| Backend and authz | NestJS detection only | API, auth, worker, webhook, cron, rate-limit analysis |
| Security | Secrets (tree + history), dependency rules, opt-in OSV | Secrets, permission, vulnerability, supply chain |
| Infrastructure | Dockerfile and GitHub Actions | Hosting and deployment analysis |
| Performance | No semantic analyzer | Cache, query, memory, profiling |
| AI systems | Agent-surface audit: MCP configs, `SKILL.md` grants, permission settings | Prompt, token, grounding analysis |

North-star entries are planned modules, not shipped behavior. Read [docs/architecture.md](docs/architecture.md) for the full precision and bounded-report contract.

## Read-only by design

Codebase Doctor reports. It never edits, repairs, or removes files, and it holds no write authority over your target files — a human or a separately authorized agent makes changes, then reruns the same scope to verify.

- `--changed` grants no command execution, network, or database access
- validation commands need `--run-checks`; live database needs `--with-database`; OSV lookup needs `--with-advisories`
- database credentials come from `DATABASE_URL` or `SUPABASE_DB_URL`, never a connection-string flag
- source analysis parses syntax and never executes source; lockfile analysis never invokes a package manager
- apart from an explicitly requested OSV lookup, it makes no external network calls

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Requested audits completed and no finding met the threshold |
| `1` | Requested audits completed and at least one finding met the threshold |
| `2` | An audit could not complete, or coverage was incomplete under `--require-complete` |

Exit `2` is an operational failure, not a clean result.

## Baselines and SARIF

`--baseline` classifies fingerprints as new, unchanged, or resolved, and applies `--fail-on` only to *new* findings. After an external fix, confirm it:

```bash
codebase-doctor audit . --json > before.json
# ... fix happens elsewhere ...
codebase-doctor verify . --baseline before.json
```

`verify` reports each fingerprint as `resolved`, `unchanged`, `unresolved`, or `new`, and exits `1` unless everything is verifiably resolved. `unresolved` means absent under incomplete coverage — never a repair.

## MCP server and agents

```bash
claude mcp add codebase-doctor -- npx -y codebase-doctor mcp
```

Read-only tools: `audit_codebase`, `verify_changes`, `explain_finding`, `describe_capabilities`. Responses are bounded at roughly 50 KB; the server never enables `--run-checks` or live database access.

`codebase-doctor instructions` prints ready-to-paste snippets for `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.windsurfrules`, `.clinerules/`, and copilot instructions. It only prints — it never writes files.

Workflow: `audit . --changed --format brief` after edits, full `audit .` at trust boundaries, `verify` after an external fix.

## Roadmap

- Built-in backend, performance, and AI semantic audit coverage
- Per-domain coverage guarantees beyond the global `--require-complete` gate
- Pull-request annotations, hooks, and agent plugins on the same report schema
- Approved validation in read-only mounts or disposable copies
- Cross-model benchmarks: defects found, false positives, verification success, token cost

## Development

```bash
npm install && npm run build && npm run typecheck && npm test
```

Releases are checked with `npm pack`, installed into a clean temporary project, and run through the generated binary.

## License

MIT
