# Pheromone signals

A **pheromone signal** is a privacy-bounded summary of an audit that can be
shared with anyone. It answers "which defect classes occur?" without
revealing anything about the codebase that produced it.

This is the first step of the
[Doctor 2036 roadmap](https://github.com/subhajitlucky/codebase-doctor/blob/main/DOCTOR_2036_VISION.md)
move #5: a federated immune system where swarms learn which patterns actually
occur, without leaking code.

```bash
codebase-doctor audit . --pheromone signal.json            # digest-only
codebase-doctor audit . --pheromone signal.json --receipt-key key.pem  # signed
codebase-doctor pheromone merge signals/*.json --min-signals 3 --out index.json
```

## Privacy contract

A signal contains **only**:

| Field | Example |
| --- | --- |
| `tool` | name and version |
| `emittedAt` | timestamp |
| `scope.auditScope` | `full` or `changed` |
| `scope.score` | Repo Health score |
| `scope.coverageComplete` | boolean |
| `scope.suppressed` | count |
| `patterns[]` | `{ ruleId, severity, count }` |

A signal **never** contains paths, filenames, fingerprints, source text,
secret values, import specifiers, repository names, or hostnames. The test
suite asserts this on serialized output.

## Integrity

- **Digest**: SHA-256 over the canonical JSON body (recursively sorted keys).
- **Signature (optional)**: `--receipt-key` supplies an Ed25519 key; the
  signal carries the signature and public key.

`pheromone merge` verifies every input. By default it **fails closed** —
tampered or malformed signals cause exit `2` and no index is written. With
`--allow-invalid`, invalid signals are skipped and counted instead.

## The pattern index

The merge output aggregates verified signals:

```json
{
  "indexVersion": "1",
  "signals": { "total": 12, "verified": 12, "rejected": 0 },
  "minSignals": 3,
  "patterns": [
    { "ruleId": "security/secrets/provider-token", "severity": "high", "signals": 5, "occurrences": 7 }
  ],
  "digest": { "algorithm": "sha256", "value": "…" }
}
```

**k-anonymity**: patterns observed in fewer than `--min-signals` signals are
excluded, so a rare pattern cannot be attributed back to a single
repository. For public indexes, `--min-signals 3` or higher is recommended;
the default is `1` for small private fleets.

## Why this exists

Telemetry today is vendor-hosted and opaque: it tells the vendor everything
and the community nothing. A pheromone index is the opposite — a commons.
Every participant can read the same aggregate, verify every contribution,
and learn which patterns actually occur in the wild. No code leaves the
machine, and no single participant can poison the index without failing
verification.
