# Benchmark results — 2026-10-09

Dated snapshot of `npm run benchmark` on this repository's seeded fixtures.
Every case builds a disposable git repository with one seeded defect, runs the
built CLI, and scores recall, medium+ false positives, review verdicts,
suppression honesty, and runtime. The harness is deterministic: no network, no
model, no database.

## Headline numbers

| Metric | Result |
| --- | --- |
| Cases passed | **17 / 17** |
| Rule recall | **16 / 16** expected rule matches (100%) |
| Medium+ false positives | **0** across 17 cases |
| Review verdicts | **2 / 2** (`REQUEST_CHANGES`, `APPROVE`) |
| Suppression honesty | **1 / 1** (gated nothing, still listed, never resolved) |
| Runtime | **4,728 ms** total · ~278 ms per case |

Reproduce:

```bash
npm run build && node scripts/benchmark.mjs --out results.json
```

Exit code is `0` only when every selected case passes. The JSON includes the
same per-case detail plus a `summary` object with the aggregate metrics above.

## Per-case results

| Case | Expected rule(s) | Outcome | ms |
| --- | --- | --- | --- |
| `secrets-tracked` | `security/secrets/provider-token` | PASS | 284 |
| `secrets-history` | `security/secrets-history/provider-token` | PASS | 280 |
| `import-missing` | `source/import-target-missing` | PASS | 269 |
| `docker-unpinned` | `infrastructure/docker/unpinned-base-image` | PASS | 269 |
| `workflow-injection` | `infrastructure/github-actions/script-injection` | PASS | 267 |
| `a11y-img` | `frontend/accessibility/img-missing-alt` | PASS | 258 |
| `cors-wildcard` | `backend/auth/cors-wildcard-origin-with-credentials` | PASS | 275 |
| `build-artifact` | `performance/static/committed-build-artifact` | PASS | 314 |
| `sql-concat` | `backend/api/sql-string-concat-query` | PASS | 283 |
| `child-exec` | `backend/api/child-process-exec-dynamic` | PASS | 281 |
| `dangerous-html` | `frontend/security/dangerously-set-inner-html` | PASS | 289 |
| `python-insecure-git` | `security/dependencies/insecure-source` + `mutable-git-source` | PASS | 273 |
| `python-missing-lock` | `security/dependencies/missing-lockfile` | PASS | 254 |
| `python-drift` | `security/dependencies/manifest-lock-drift` | PASS | 268 |
| `review-request-changes` | verdict `REQUEST_CHANGES`, exit 1 | PASS | 284 |
| `review-approve` | verdict `APPROVE`, exit 0 | PASS | 301 |
| `suppression-honesty` | acknowledged finding gates nothing, stays listed | PASS | 279 |

Cases that also surface `repository/no-visible-tests` do so at info severity;
info/low hygiene noise is reported but never scored, so it cannot inflate or
deflate the false-positive rate.

## What is measured

- **Recall** — every expected rule id must be present in the report.
- **Medium+ false positives** — any unexpected finding at medium, high, or
  critical severity fails the case. This is the precision-first contract.
- **Review verdicts** — `review` must return `REQUEST_CHANGES` for a defect on
  an added line and `APPROVE` when the same secret is unchanged, with matching
  exit codes.
- **Suppression honesty** — a `codebase-doctor-ignore` finding must gate
  nothing, remain listed under `suppressed`, and never report as resolved.
- **Runtime** — wall-clock milliseconds per case, including git fixture setup.

## What is not measured

- **Live database coverage.** No offline run can complete live PostgreSQL
  coverage, so `verify`-after-repair (`resolved`) is covered at unit level
  instead; a file-based benchmark could only ever score `unresolved`.
- **Cross-model comparison.** Different reviewers on the same fixtures, with
  token cost, is the next layer. This harness scores the deterministic floor
  every model-assisted review must clear first.
- **Adversarial or large-repository recall.** Fixtures are single-defect and
  small by design; they measure correctness of the contract, not scale.

## Environment

| | |
| --- | --- |
| Commit | `5bf12e6` |
| Node | v24.19.0 |
| Platform | Linux x86_64 |
| Date | 2026-10-09 |
