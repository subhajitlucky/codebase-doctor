# GitHub Action

Run codebase-doctor on every push or pull request and surface findings in the Actions UI and GitHub code scanning.

```yaml
name: Audit

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  codebase-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: subhajitlucky/codebase-doctor@main
        with:
          path: .
          format: sarif
          output: codebase-doctor.sarif
          fail-on: high
          require-complete: "false"

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: codebase-doctor.sarif
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Repository path to audit |
| `format` | `sarif` | `text`, `json`, or `sarif` |
| `output` | `codebase-doctor.sarif` | File to write the report to |
| `fail-on` | `high` | Threshold that fails the job: `info`, `low`, `medium`, `high`, `critical`, `none` |
| `require-complete` | `"false"` | Fail with exit code 2 when audit coverage is incomplete |
| `run-checks` | `"false"` | Permit execution of detected validation commands |
| `version` | `latest` | codebase-doctor version to install from npm |
| `node-version` | `20` | Node.js version used to run the CLI |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `fail-on` |
| `1` | Findings at or above `fail-on` |
| `2` | Operational failure (bad input, failed doctor) or incomplete coverage with `require-complete` |

## Changed-scope audits on pull requests

To audit only what a pull request touches, pass `--changed` through the CLI directly or run:

```yaml
      - run: npx --yes codebase-doctor scan . --changed --base origin/${{ github.base_ref }} --format sarif > codebase-doctor.sarif
```

## Notes

- The action installs the published npm package; pin `version` for reproducible runs.
- `require-complete: "true"` makes partial domain coverage a failing condition, so a "clean" result is never reported when analyzers were skipped or unsupported.
- `run-checks: "true"` executes repository-owned validation commands and should be used only on trusted code.
