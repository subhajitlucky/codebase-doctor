# Red-team self-play

`npm run red-team` runs an adversarial mutation corpus against the built
audit pipeline. It is the executable form of "the attacker evolves, the
doctor must still defend":

- **Mutants** seed a real, statically decidable defect in a different shape
  than the benchmark case. The audit **must still find the expected rule**.
  A miss is an **evasion** (defense gap) and fails the run.
- **Controls** seed a safe or recommended pattern. The audit **must not**
  report the rule. A hit is a **false positive** and fails the run.

Current corpus (18 cases):

| Kind | Case | Rule |
| --- | --- | --- |
| mutant | secret in a JSON config | `security/secrets/provider-token` |
| mutant | secret in a code comment | `security/secrets/provider-token` |
| mutant | secret in a tracked `.env` | `security/secrets/provider-token` |
| control | placeholder-shaped token | `security/secrets/provider-token` |
| mutant | re-export from a missing file | `source/import-target-missing` |
| mutant | literal dynamic `import()` | `source/import-target-missing` |
| mutant | literal `require()` in `.cjs` | `source/import-target-missing` |
| control | import that resolves | `source/import-target-missing` |
| mutant | injection via PR title | `infrastructure/github-actions/script-injection` |
| control | env-var indirection | `infrastructure/github-actions/script-injection` |
| mutant | untagged Docker base | `infrastructure/docker/unpinned-base-image` |
| control | digest-pinned Docker base | `infrastructure/docker/unpinned-base-image` |
| mutant | TSX `img` without `alt` | `frontend/accessibility/img-missing-alt` |
| control | `img` with `alt` | `frontend/accessibility/img-missing-alt` |
| mutant | SQL string concatenation via `pg` | `backend/api/sql-string-concat-query` |
| control | parameterized SQL | `backend/api/sql-string-concat-query` |
| mutant | template command through `exec` | `backend/api/child-process-exec-dynamic` |
| control | `execFile` with an argument array | `backend/api/child-process-exec-dynamic` |

## Out of scope — deliberately

The harness never demands guesses. Mutations that are **not statically
decidable** are excluded, because the contract is precision-first and those
cases are reported as coverage limitations instead:

- base64/encrypted/obfuscated secrets, runtime string assembly
- extensionless import specifiers, ambiguous aliases, custom loaders
- reflected CORS origins built from non-literal expressions

If one of these becomes decidable with a sound static proof, it moves from
"out of scope" to a mutant.

## Running

```bash
npm run red-team                       # whole corpus, exit 1 on any failure
node scripts/red-team.mjs --list       # list cases
node scripts/red-team.mjs --only secrets-comment,import-reexport
node scripts/red-team.mjs --out results.json
```

`ci:full` runs the corpus, so a defense regression fails CI. Adding a case:
append to `CASES` in `scripts/red-team.mjs` with `kind`, `rule`, and `setup`;
the harness builds a disposable git repository, commits the fixture, and
audits it with the built CLI.

## Why this exists

Every detector claim is testable, and every evasion found here becomes either
a fixed detector or a documented, precision-bounded limitation. That is the
difference between "we scan for X" and "we can show you what our scanner
still catches after you try to hide X."
