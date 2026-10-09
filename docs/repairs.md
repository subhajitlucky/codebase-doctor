# Proof-carrying repairs

`codebase-doctor fix` generates a repair for a finding and verifies it in a
**disposable copy** before writing anything. The patch arrives with a
machine-checked certificate:

1. it resolves the target finding fingerprint, and
2. it introduces no new medium-or-higher findings.

The original repository is never modified. You get a patch file and a
receipt; a human or a separately authorized agent applies the patch, then
reruns `audit` and `verify` on the same scope.

```bash
codebase-doctor fix <fingerprint> . --patch fix.patch --receipt fix.json
```

Get a fingerprint from `codebase-doctor audit . --json`.

## Supported repair

`source/import-target-missing` — an import pointing at a file that does not
exist:

- The tool re-reads the importer and finds the broken relative specifier.
- It searches the repository for an unambiguous candidate by stem: exact
  stem match first, then prefix matches, preferring the importer's own
  directory.
- Zero candidates, or two candidates with equal rank, means **no repair** —
  the tool never guesses.

```
src/app.ts — "./helpers.js" -> "./helper.js"
```

## The verification gate

| Check | Rule |
| --- | --- |
| Finding resolved | the target fingerprint must be absent after the patch |
| No regressions | no new **medium or higher** finding may appear |
| Advisories | new info/low findings are listed as non-blocking |
| Doctor health | no doctor run may fail while verifying |

Verification runs in a **shadow copy**: the repository is cloned into a
temporary directory, the patched file is applied there, and the full audit
re-runs. The patch is a real `git diff` captured from the copy. If
verification fails, no patch is written and nothing is applied.

## The receipt

Canonical JSON with a SHA-256 digest over the body:

```json
{
  "repairVersion": "1",
  "subject": {
    "root": ".",
    "finding": { "ruleId": "source/import-target-missing", "fingerprint": "…", "location": "src/app.ts" },
    "repair": { "file": "src/app.ts", "from": "./helpers.js", "to": "./helper.js" }
  },
  "patch": { "format": "git-diff", "text": "…", "sha256": "…" },
  "verification": {
    "status": "verified",
    "mode": "static+shadow",
    "resolved": ["source/import-target-missing src/app.ts"],
    "newFindings": [],
    "advisoryFindings": []
  },
  "digest": { "algorithm": "sha256", "value": "…" }
}
```

The patch hash binds the certificate to the exact bytes a reviewer approves.

Exit `0` when a verified patch is written, `1` when verification fails, `2`
when no finding, no unambiguous candidate, or no `--patch` destination
exists.
