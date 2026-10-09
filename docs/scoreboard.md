# Differential scoreboard — doctors verifying doctors

*Snapshot: 2026-10-09 · codebase-doctor v0.4.7 · rls-doctor v0.5.4*

Two independent offline analyzers — codebase-doctor's `database/sql-rls`
module and rls-doctor's `--schema-file` analyzer — run over the same SQL
corpus. The scoreboard publishes agreement, divergence, and the rule
coverage matrix. Divergence is information, not failure: implementation
drift should be visible, not hidden.

Reproduce: `npm run differential` (or `node scripts/differential.mjs`) with
both repositories checked out side by side, or set `RLS_DOCTOR_PATH`.
A weekly GitHub workflow publishes the same scoreboard to the Actions job
summary.

## Results

| Fixture | codebase-doctor | rls-doctor | matched | only-codebase | only-rls | severity mismatches |
| --- | --- | --- | --- | --- | --- | --- |
| `unsafe.sql` | 8 | 9 | 7 | 0 | 1 | 0 |
| `safe.sql` | 0 | 0 | 0 | 0 | 0 | 0 |
| `defaults-and-roles.sql` | 3 | 3 | 3 | 0 | 0 | 0 |

Totals: **10 matched**, 0 only-codebase, 1 only-rls, 0 severity mismatch(es).

## Rule coverage matrix

| Rule | codebase-doctor | rls-doctor |
| --- | --- | --- |
| `broad-default-table-privilege` | — | yes |
| `force-rls-disabled` | yes | yes |
| `public-permissive-policy` | yes | yes |
| `public-unconditional-read` | yes | yes |
| `public-unconditional-write` | yes | yes |
| `reachable-truncate` | yes | yes |
| `rls-disabled-exposed` | yes | yes |
| `write-policy-missing-check` | yes | yes |

Notes:

- **`safe.sql` is clean under both analyzers** — cross-validation that the
  safe reference schema produces no high-severity disagreement.
- The single divergence is a **known coverage difference**: rls-doctor
  implements `broad-default-table-privilege`; codebase-doctor's offline
  `sql-rls` does not. It is listed, not hidden.
- Severity values agree on every matched finding. Where the corpus produces
  duplicate keys (for example two permissive-policy findings on one table),
  both analyzers deduplicate the same way.
- Rules that are not in the corpus (for example `rls-bypass-role`, which
  needs role attributes) are outside this snapshot; the matrix lists what the
  corpus exercised.

## Why this exists

Vendors publish marketing benchmarks. A self-auditing referee publishes
disagreement. This scoreboard is the first step of the
[Doctor 2036 roadmap](https://github.com/subhajitlucky/codebase-doctor/blob/main/DOCTOR_2036_VISION.md)
move #10: when two independently written analyzers agree on the same
evidence, confidence goes up; when they disagree, the divergence is a bug
report or a documented coverage fact — never a silent guess.
