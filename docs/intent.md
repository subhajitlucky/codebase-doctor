# Intent verification

`codebase-doctor intent verify` checks **declared intent** against audit
evidence. It is the first step of the
[Doctor 2036 roadmap](https://github.com/subhajitlucky/codebase-doctor/blob/main/DOCTOR_2036_VISION.md)
move #7: verifying the artifact against what the author said it would do.

It never interprets prose. Intent that is not declared cannot be verified —
and the doctor says so instead of guessing.

```bash
codebase-doctor intent verify intent.json .
codebase-doctor intent verify pr.md . --require-verified
codebase-doctor intent verify intent.json --report saved-audit.json --out report.json
```

## Declaring intent

Two sources are supported:

1. **JSON** — `{ "intentVersion": "1", "summary": "…", "claims": [ … ] }`
2. **Markdown** — one or more fenced blocks:

````markdown
# PR: remove the leaked credential

The agent says it removed the leak. This prose is **not** interpreted.

```intent
{
  "intentVersion": "1",
  "claims": [
    { "id": "no-secrets", "kind": "rule-absent", "ruleId": "security/secrets/provider-token" },
    { "id": "score", "kind": "score-at-least", "value": 90 },
    { "id": "coverage", "kind": "coverage-complete" }
  ]
}
```
````

Prose outside the blocks is counted and reported as unstructured characters.

## Claim kinds

| Kind | Meaning |
| --- | --- |
| `rule-absent` | no finding with `ruleId` (optionally under `pathPrefix`) |
| `rule-present` | at least one finding with `ruleId` |
| `score-at-least` | the Repo Health score is at least `value` |
| `coverage-complete` | every applicable audit domain completed |

## Statuses and honesty

| Status | Meaning |
| --- | --- |
| `verified` | the evidence supports the claim |
| `violated` | the evidence contradicts the claim, with locations |
| `undecided` | the claim depends on coverage that did not complete |

`rule-absent` and `rule-present` claims are **undecided** when the domain
that owns the rule has incomplete coverage — absence under incomplete
coverage is never counted as verified. `score-at-least` and
`coverage-complete` are decidable from the report alone.

Exit codes: `1` when any claim is violated; `2` with `--require-verified`
when any claim is undecided; `2` on operational failure.

## Report artifact

`--out` writes a canonical JSON report with a SHA-256 digest over the body
(recursively sorted keys): subject, summary counts, per-claim statuses with
reasons and bounded evidence, and the unstructured-text count.

## Why this exists

Coding agents describe what they did — in PR bodies, commit messages, plans.
Today that text is unverifiable marketing. Intent verification turns the
checkable parts into explicit claims and holds them against receipts-grade
evidence, while refusing to pretend that free text was understood.
