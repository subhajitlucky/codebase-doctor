# Coverage receipts

A **coverage receipt** is a small, portable artifact that states what an audit
checked, what it could not check, the deterministic score, and the
fingerprints of what it found. It is the first step of the
[Doctor 2036 roadmap](https://github.com/subhajitlucky/codebase-doctor/blob/main/DOCTOR_2036_VISION.md):
verification that any agent or CI pipeline can carry, compare, and verify.

```bash
codebase-doctor audit . --receipt receipt.json              # digest-only
codebase-doctor audit . --receipt receipt.json --receipt-key key.pem   # signed
codebase-doctor verify-receipt receipt.json                 # exit 0 valid, 2 invalid
```

## Format (`receiptVersion: "1"`)

| Field | Meaning |
| --- | --- |
| `tool` | name and version of the issuing tool |
| `issuedAt` | issuance timestamp (UTC ISO) |
| `subject` | audited root and scope (`full` / `changed`) |
| `score` | deterministic score and band |
| `coverage.complete` | whether every applicable domain completed |
| `coverage.limitations` | exactly what was skipped, partial, or failed |
| `findings.total` / `bySeverity` | counts only — never secrets or source |
| `findings.fingerprints` | stable finding fingerprints, sorted |
| `suppressed` | acknowledged finding count |
| `digest` | SHA-256 over the canonical JSON body |
| `signature` | optional Ed25519 signature + public key |

## Integrity model

- **Canonicalization**: object keys are sorted recursively, so the same
  receipt body always hashes to the same bytes.
- **Digest**: `sha256` over the canonical body. Any change to any field
  invalidates the receipt — `verify-receipt` exits `2`.
- **Signature (optional)**: when `--receipt-key` supplies an Ed25519 private
  key (PKCS#8 PEM), the receipt carries a signature and the public key.

What the model proves, honestly:

- A digest-only receipt proves **tamper evidence**: nobody can alter a field
  without invalidating it.
- A signed receipt proves **the holder of that private key issued it**.
  Authenticity requires the public key to be pinned out-of-band; a receipt
  carrying its own key is not self-authenticating.
- Neither form proves the audited code is correct — only what the audit
  covered and what it found.

## Verification output

```
receipt: codebase-doctor 0.4.2 · issued 2026-10-09T07:22:54.222Z
subject: /repo (scope=full)
score: 90/100 (green)
coverage: incomplete
  - validation: skipped
  - database: skipped
findings: 1 (info 1)
suppressed: 0
signature: none (digest only)
integrity: digest verified
```

Exit codes: `0` valid, `2` invalid, unreadable, or not a receipt. Receipts
never contain secret values, source text, or import specifiers — the same
withholding rules as reports.

## Why this exists

Agent swarms need to exchange verification results without trusting each
other. A receipt is the unit of that exchange: bounded, deterministic, and
checkable. It is deliberately boring to parse and impossible to quietly edit.
