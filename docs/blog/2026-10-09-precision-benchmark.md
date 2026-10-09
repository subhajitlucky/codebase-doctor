# 100% recall, zero medium+ false positives: benchmark numbers for Codebase Doctor

*2026-10-09 · Codebase Doctor v0.4.0*

Every code scanner says it "catches issues." Almost none publish numbers. We
just made ours reproducible, so here they are — including what the benchmark
does **not** cover.

## The numbers

17 seeded single-defect fixtures, deterministic offline audit pipeline:

| Metric | Result |
| --- | --- |
| Cases passed | **17 / 17** |
| Rule recall | **16 / 16** expected rule matches (100%) |
| Medium+ false positives | **0** across 17 cases |
| Review verdicts | **2 / 2** (`REQUEST_CHANGES`, `APPROVE`) |
| Suppression honesty | **1 / 1** |
| Runtime | **4.7 s** total (~278 ms per case) |

The cases cover committed secrets (working tree and git history), missing
import targets, unpinned Docker bases, workflow script injection,
accessibility, CORS-with-credentials, committed build artifacts, SQL string
concatenation, dynamic child-process execution, dangerous HTML sinks, Python
dependency hazards, PR review verdicts, and suppression honesty.

## Why this shape of benchmark

Two things make a scanner benchmark honest:

1. **Seeded defects, not vibes.** Each case builds a disposable git repo with
   exactly one defect and asserts the exact rule id that must fire.
2. **A false-positive gate.** Any unexpected finding at medium severity or
   above fails the case. Info/low hygiene noise (like "no visible tests") is
   reported but never scored — it cannot pad or punish the rate.

That second rule is the whole point. A scanner with 100% recall and a flood of
guesses is worse than useless: it trains you to ignore it. Codebase Doctor's
contract is *"it finds the thing, and it never guesses"* — and the benchmark
enforces the second half.

We also score the behaviors that are easy to fake:

- **Review verdicts** must be `REQUEST_CHANGES` for a defect on an added line
  and `APPROVE` when the same secret is only context.
- **Suppression honesty** — an acknowledged finding must gate nothing, stay
  listed under `suppressed`, and never report as resolved.

## What we deliberately don't claim

- **Live database coverage is not in this benchmark.** An offline run cannot
  complete live PostgreSQL coverage, so `verify`-after-repair is covered at
  unit level instead of being scored here. We'd rather say that than print a
  flattering number.
- **This is not a scale test.** Fixtures are small and single-defect by design;
  they measure the correctness contract, not performance on a monorepo.
- **No cross-model comparison yet.** That's the next layer: different
  reviewers on the same fixtures, with token cost. This benchmark is the
  deterministic floor any model-assisted review must clear first.

## Reproduce it

```bash
git clone https://github.com/subhajitlucky/codebase-doctor
cd codebase-doctor
npm ci && npm run build
node scripts/benchmark.mjs --out results.json
```

Exit code is `0` only when every case passes. The JSON carries per-case
detail and an aggregate `summary`. The full snapshot lives in
[`docs/benchmark-results.md`](../benchmark-results.md).

If you find a seeded case where the tool guesses, misses, or lies about
coverage, that's a bug — open an issue with the fixture.
