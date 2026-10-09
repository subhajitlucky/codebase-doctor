# Exploit witnesses

A finding tells you a pattern is risky. `codebase-doctor witness` tells you
**what the exploit is**:

```
$ codebase-doctor witness <fingerprint> .
Finding: backend/api/sql-string-concat-query src/db.ts:4
Payload:     ' OR '1'='1' --
Transformed: select * from users where id = '' OR '1'='1' --'
Why:         the payload closes the string literal and makes the predicate a tautology,
             so the query returns every row
```

The transformed sink text is computed **statically** from the call
expression. Nothing is executed, nothing is submitted, and the artifact is
bound to the finding fingerprint with a SHA-256 digest.

## Supported rules and payloads

| Rule | Payload | What the transformation proves |
| --- | --- | --- |
| `backend/api/sql-string-concat-query` | `' OR '1'='1' --` | the predicate becomes a tautology; every row is returned |
| `backend/api/child-process-exec-dynamic` | `; echo codebase-doctor-witness` | a second command is appended to the executed string |
| `frontend/security/dangerously-set-inner-html` | `<img src=x onerror="alert(1)">` | the browser parses the payload as HTML and executes the handler |

## The decidable shapes

The synthesizer evaluates the sink argument with every dynamic segment
replaced by the payload. Supported shapes:

- string and number literals
- template literals (including TypeScript casts inside `${…}`)
- binary `+` concatenation
- parentheses, `as`/non-null/satisfies casts
- identifiers, member expressions, and calls as dynamic segments

Anything else — conditionals, function calls returning templates, other
operators — is **undecided** with the reason stated. Witness synthesis never
guesses.

## The artifact

Canonical JSON with a SHA-256 digest over the body:

```json
{
  "witnessVersion": "1",
  "subject": {
    "root": ".",
    "finding": { "ruleId": "…", "fingerprint": "…", "location": "src/db.ts:4" }
  },
  "witness": {
    "kind": "sql-injection",
    "payload": "' OR '1'='1' --",
    "transformed": "select * from users where id = '' OR '1'='1' --'",
    "explanation": "…",
    "dynamicSegments": 1
  },
  "digest": { "algorithm": "sha256", "value": "…" }
}
```

Exit `0` when a witness is synthesized, `1` when the shape or rule is
undecided, `2` on operational failure.

## Why this exists

A finding asks for trust. A witness shows the attack. Pair it with
proof-carrying repairs and the loop closes: `witness` proves a finding is
exploitable, `fix` proves the repair removes it, and both artifacts are
bound to the same fingerprint.
