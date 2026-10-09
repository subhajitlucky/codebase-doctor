# We audited 100 agent-configured repos: 23% ship at least one high-severity finding

*2026-10-09 · codebase-doctor v0.4.1 · aggregate, anonymized results*

Coding agents now ship code faster than review can keep up. So we asked what
the evidence actually says: we took 100 public repositories that carry agent
configuration files (`AGENTS.md` / `CLAUDE.md` — a proxy for agent-involved
development), shallow-cloned them, and ran the full offline Codebase Doctor
audit. No repository was named, and no repository code was executed.

## Headline numbers

| Metric | Result |
| --- | --- |
| Repositories analyzed | 100 (35 more skipped by the 30 MB size cap) |
| Repos with ≥1 **high-severity** finding | **23 / 100 (23%)** |
| Repos with a **committed provider token** | 1 / 100 (1%) |
| Repos with a **broken import target** | 10 / 100 (10%) |
| Repos with **private key material** in the tree | 4 / 100 (4%) |
| Repos with **risky agent configuration** (`ai/*`) | 11 / 100 (11%) |
| Repos with high-confidence **sensitive assignments** (medium) | 19 / 100 (19%) |
| Repos with **zero findings** | 24 / 100 |
| Median Repo Health score | **84 / 100** (average 64) |

## What showed up

High-severity findings, counted by repositories containing at least one:

| Pattern | Repos |
| --- | --- |
| `source/import-target-missing` — imports pointing at files that don't exist | 10 |
| `backend/api/child-process-exec-dynamic` — non-static commands through `exec` | 6 |
| `security/secrets/private-key` — key material committed to the tree | 4 |
| `infrastructure/docker/pipe-to-shell`, workflow checkout/injection patterns | 5 combined |
| dependency insecure-source / workspace resolution | 3 |

The agent surface itself is not exempt: 11 repositories had findings under
`ai/*` — unscoped `allowed-tools` grants in `SKILL.md`, unpinned MCP package
runners, or permission-bypass settings.

Medium-severity volume was dominated by hygiene: missing meta descriptions
(33 repos), oversized committed files (24), high-confidence sensitive
assignments like config literals (19), missing titles (14), and lockfile
integrity gaps (12). No critical findings appeared in this sample.

## What this proves — and what it doesn't

**It proves the pattern, not the incident.** A broken import is a real build
hazard; a `ghp_`-shaped string can be a rotated fixture; a `pipe-to-shell` can
be gated. What the numbers say is that in agent-heavy repositories, the
mechanical failures that block merges are common — and cheap to catch
automatically before a human reviews.

**Shallow clones limit history scanning.** Clones used `--depth 1`, so
`security/secrets-history` only sees the tip commit. The committed-secret
figure is a working-tree number; real history exposure is at least this high,
never lower.

**The sample is a proxy, not a census.** Repositories carrying `AGENTS.md` or
`CLAUDE.md` are not necessarily agent-built, and the first 100 unique
non-fork results under the size cap are a convenience sample. We state it so
nobody reads this as a survey of the ecosystem.

**No repository is named.** Per our
[disclosure policy](../disclosure-policy.md), only aggregate, anonymized
numbers are published.

## Reproduce it

```bash
git clone https://github.com/subhajitlucky/codebase-doctor
cd codebase-doctor && npm ci && npm run build
GITHUB_TOKEN=... node scripts/study-agent-repos.mjs --limit 100 --out results.json
```

The script prints and writes only aggregate, anonymized records (repository
indexes, no names). Numbers move as repositories change; the snapshot above is
from 2026-10-09.

## The takeaway

One command shows the whole loop with zero setup:

```bash
npx codebase-doctor demo
# disposable fixture: tracked secret, broken import, blast radius, exit 1
```

Then put the same audit in CI with `audit . --changed --fail-on high` — or
`--format html` when a human wants the receipts.
