# Benchmark

`npm run benchmark` scores the deterministic audit pipeline against seeded
single-defect fixtures. It is the executable form of the precision-first
contract: every rule must fire where it should and stay silent elsewhere.

## What it measures

Each case builds a disposable git repository with one seeded defect, runs the
built CLI, and scores:

- **recall** — every expected rule id is reported;
- **false positives** — no unexpected finding at medium severity or above
  (info/low hygiene noise such as `repository/no-visible-tests` is reported
  but never scored);
- **verdicts** — `review` returns `REQUEST_CHANGES` for defects on added
  lines and `APPROVE` otherwise, with matching exit codes;
- **suppression honesty** — an acknowledged finding gates nothing, stays
  listed, and never resolves;
- **runtime** — wall-clock milliseconds per case.

`verify`-after-repair (`resolved`) is covered at unit level, not here: no
offline run can complete live database coverage, so a file-based benchmark
could only ever score `unresolved`. That limitation is documented, not hidden.

## Current results (17 cases, ~5s total)

| Case | Expectation | Result |
| --- | --- | --- |
| `secrets-tracked` | `security/secrets/provider-token` | PASS |
| `secrets-history` | `security/secrets-history/provider-token` | PASS |
| `import-missing` | `source/import-target-missing` | PASS |
| `docker-unpinned` | `infrastructure/docker/unpinned-base-image` | PASS |
| `workflow-injection` | `infrastructure/github-actions/script-injection` | PASS |
| `a11y-img` | `frontend/accessibility/img-missing-alt` | PASS |
| `cors-wildcard` | `backend/auth/cors-wildcard-origin-with-credentials` | PASS |
| `build-artifact` | `performance/static/committed-build-artifact` | PASS |
| `sql-concat` | `backend/api/sql-string-concat-query` | PASS |
| `child-exec` | `backend/api/child-process-exec-dynamic` | PASS |
| `dangerous-html` | `frontend/security/dangerously-set-inner-html` | PASS |
| `python-insecure-git` | insecure + mutable git source | PASS |
| `python-missing-lock` | `security/dependencies/missing-lockfile` | PASS |
| `python-drift` | `security/dependencies/manifest-lock-drift` | PASS |
| `review-request-changes` | verdict `REQUEST_CHANGES`, exit 1 | PASS |
| `review-approve` | verdict `APPROVE`, exit 0 | PASS |
| `suppression-honesty` | gated nothing, still listed, exit 0 | PASS |

17/17 passing with zero medium+ false positives. Re-run with
`node scripts/benchmark.mjs --out results.json [--cases a,b]`; exit code is
`0` only when every selected case passes.

## What it does not do yet

Cross-model comparison (different reviewers on the same fixtures, with token
cost) is the next layer: the harness scores deterministic doctor behavior,
which is the floor every model-assisted review must clear first.

## Regression value

The harness has already paid for itself during development: it caught
unreachable `dist/`/`build/` artifact patterns (the inventory skips those
directories at every depth) and an imprecise HTML fixture that masked two
additional true positives.
