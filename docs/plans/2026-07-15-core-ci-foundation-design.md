# Core CI Foundation Design

## Purpose

Codebase Doctor will remain a small, deterministic diagnostic orchestrator. This
milestone strengthens the core contract that future frontend, backend, database,
security, infrastructure, performance, and AI doctor packages will use. It does
not add those specialized doctor packs yet.

The milestone adds four connected capabilities:

1. Read-only command-plan preview.
2. Configurable repository exclusions.
3. Baseline and diff-aware findings.
4. SARIF output for CI integrations.

## Product Shape

The project follows a core-first extension model:

```text
Specialized doctor packages and external tools
                    |
                    v
Codebase Doctor core
discovery -> planning -> execution -> normalization -> comparison
                    |
                    v
Text, JSON, SARIF, CI, and coding agents
```

The core owns stable scan, finding, evidence, execution, comparison, and reporter
contracts. Specialized analysis should live in curated packages such as a future
`@codebase-doctor/security` package or in external adapters. Runtime-dependent
analysis, including profiling and hallucination evaluation, remains optional and
must declare the capabilities it needs.

## Compatibility

- Existing CLI behavior remains valid.
- `--json` remains a supported alias for JSON output.
- JSON reports retain schema version `1`.
- New JSON fields are additive and optional where necessary.
- Existing doctor IDs, rule IDs, finding fingerprints, severities, and exit-code
  meanings remain stable.
- SARIF is a separate output format and does not change the JSON schema.

## CLI Design

The scan command gains these options:

```text
--format <format>       text, json, or sarif
--exclude <glob>        exclude a path; repeatable
--baseline <path>       compare with a prior Codebase Doctor JSON report
```

`--json` is equivalent to `--format json`. Supplying `--json` with a non-JSON
`--format` is an operational error and exits `2`.

Every scan plans supported checks. Without `--run-checks`, plans are reported but
never executed. With `--run-checks`, the same immutable plans are executed. This
closes the consent gap in which users previously could not inspect plans before
granting process execution.

## Configuration and Exclusions

The scanner looks for `.codebase-doctor.json` in the requested repository root.
The first configuration contract is intentionally small:

```json
{
  "exclude": ["test/fixtures/**", "examples/generated/**"]
}
```

CLI exclusions are appended to configuration exclusions. Built-in generated and
vendor directory exclusions remain active. Exclusion patterns use repository-
relative POSIX paths regardless of host platform. A matching directory prevents
descent; a matching file is omitted from the inventory.

Malformed JSON, unknown configuration keys, non-string exclusions, absolute
patterns, and patterns that escape the repository are operational errors. The
configuration file itself remains visible to inventory unless explicitly
excluded.

## Planning

Check discovery is separated from check execution. Ecosystem adapters produce
immutable `CommandPlan` records without requiring `process:execute`. The scan
result includes a deterministic `plannedChecks` array containing project ID,
plan ID, display command, and check kind.

The Check Doctor receives those plans only when execution is authorized. A
missing executable remains a skipped check, a non-zero exit remains a finding,
and operational failures remain separate from code findings.

Text output shows a `Planned checks` section. JSON includes `plannedChecks`.
SARIF does not encode plans because SARIF represents diagnostic results, not an
execution protocol.

## Baselines and Comparison

`--baseline` accepts a prior Codebase Doctor JSON schema `1` report. Comparison
uses finding fingerprints:

- `new`: present now, absent from the baseline.
- `unchanged`: present in both reports.
- `resolved`: absent now, present in the baseline.

The current findings array remains unchanged. An additive `comparison` object
contains deterministic fingerprint arrays and severity counts for new findings.
Resolved entries are represented by baseline fingerprints because the current
scan may no longer have repository evidence for them.

When a baseline is supplied, `--fail-on` evaluates only new findings. Without a
baseline, threshold behavior is unchanged. Invalid JSON, unsupported schema
versions, missing finding fingerprints, and unreadable baseline files exit `2`.

The CLI does not write baseline files. Users create one with ordinary output
redirection, keeping filesystem writes explicit:

```bash
codebase-doctor scan . --json > codebase-doctor-baseline.json
```

## SARIF Reporter

`--format sarif` emits SARIF 2.1.0 with one run. Each Codebase Doctor rule becomes
a SARIF reporting descriptor. Each current finding becomes a result containing:

- Rule ID and severity mapping.
- Message and remediation where available.
- Source location when the finding has one.
- Finding fingerprint in `partialFingerprints`.
- Baseline state when a baseline comparison exists.
- Evidence in structured result properties, with existing redaction preserved.

SARIF output is deterministic. Exit thresholds are evaluated exactly as for text
and JSON reports.

## Data Flow

```text
CLI options
   + configuration
          |
          v
validated exclusion set
          |
          v
inventory -> manifests -> project detection -> command planning
                                             |             |
                                             |             +-> optional execution
                                             v
                                         doctor results
                                             |
                                             v
                                      normalized scan result
                                             |
                              optional baseline comparison
                                             |
                                             v
                                      text / JSON / SARIF
```

## Error Handling

Configuration, baseline, option-conflict, and output-format failures are
operational errors and exit `2`. Doctor findings continue to control exit `1`
through the configured severity threshold. One unsupported or skipped command
does not erase other scan evidence.

No scan executes subprocesses without `--run-checks`. Exclusions and baseline
loading require filesystem reads only. SARIF reporting introduces no network or
filesystem-write capability.

## Testing Strategy

Implementation follows red-green-refactor in this order:

1. Unit tests for exclusion parsing and inventory filtering.
2. Unit tests for deterministic command planning without execution.
3. Unit tests for fingerprint comparison and threshold classification.
4. Unit tests for SARIF rule, level, location, fingerprint, and baseline mapping.
5. CLI integration tests for new options, conflicts, invalid inputs, and exit
   codes.
6. Regression tests proving `--json`, schema `1`, read-only scans, execution
   consent, redaction, and existing reporters remain compatible.
7. Full typecheck, Vitest, build, package verification, and dependency audit.

## Deferred Work

- GitHub Action packaging and pull-request annotations.
- Full doctor plugin SDK and lifecycle hooks.
- Specialized frontend, backend, database, security, infrastructure,
  performance, and AI doctor packs.
- Network sandboxing for approved child processes.
- Automatic baseline file creation or mutation.
