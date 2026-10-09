# Economic verification

`codebase-doctor economy verify` replays a transaction journal in a
**disposable shadow ledger** — an in-memory simulator that never contacts a
payment system and never moves real value — and decides declared economic
invariants before anything real happens. It is the final move of the
[Doctor 2036 roadmap](https://github.com/subhajitlucky/codebase-doctor/blob/main/DOCTOR_2036_VISION.md):
rolled-back probes for money.

```bash
codebase-doctor economy verify journal.json --policy policy.json
codebase-doctor economy verify journal.json --policy policy.json --out report.json
```

## Journal format

```json
{
  "journalVersion": "1",
  "currency": "USD-cents",
  "accounts": { "agent": 1000, "merchant": 0 },
  "operations": [
    { "id": "op-1", "kind": "transfer", "from": "agent", "to": "merchant", "amount": 400 },
    { "id": "op-2", "kind": "withdraw", "from": "agent", "amount": 700 }
  ],
  "expectedBalances": { "agent": -100, "merchant": 400 }
}
```

Operation kinds: `transfer`, `deposit` (external inflow), `withdraw`
(external outflow), `mint` (inflow), `burn` (outflow). All amounts are
positive safe integers in minor units.

## Invariants

| Kind | Proves / witnesses |
| --- | --- |
| `non-negative-balances` | no account ever goes negative — catches overdraft and double-spend, with the exact operation |
| `per-operation-limit` | every operation amount is within `maxAmount` |
| `window-volume-limit` | no `window`-operation rolling window moves more than `maxAmount` |
| `allowlist` | every transfer counterparty is in `accounts` |
| `declared-balances` | the journal's `expectedBalances` match the replay exactly — catches fabricated reports |

Without `--policy`, the default invariants are `non-negative-balances` and
`declared-balances` (the latter is `undecided` when the journal declares no
expected balances).

## Statuses and exit codes

- **proved** — the invariant held across the whole replay
- **violated** — with a witness: operation id, index, detail, and the balance
  snapshot at that moment
- **undecided** — the invariant cannot be decided from the journal (for
  example `declared-balances` without declared balances); never counted as
  proved

Exit `1` when any invariant is violated; `2` with `--require-proved` when any
invariant is undecided; `2` on malformed input. `--out` writes a canonical
JSON report with a SHA-256 digest over the body.

## Example

```
VIOLATED  no-overdraft (non-negative-balances) — account agent reaches -100
          witness: op-2 (index 1) — after op-2
VIOLATED  op-limit (per-operation-limit) — amount 700 exceeds limit 500
PROVED    counterparties (allowlist) — every transfer counterparty is on the allowlist
VIOLATED  declared (declared-balances) — 1 declared balance mismatch(es)
```

The ledger exists only inside the process. Nothing was submitted, nothing
moved, and the replay is deterministic — the same journal always produces the
same verdicts and the same witnesses.
