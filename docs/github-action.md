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
| `command` | `audit` | `audit` (full repository) or `review` (changed code with a PR verdict) |
| `base` | `""` | Base ref for review/changed scope (for example, `origin/main`); empty means working-tree changes against `HEAD` |
| `format` | `sarif` | `text`, `json`, `sarif`, `brief`, `markdown`, or `github` |
| `output` | `codebase-doctor.sarif` | File to write the report to |
| `fail-on` | `high` | Threshold that fails the job: `info`, `low`, `medium`, `high`, `critical`, `none` |
| `require-complete` | `"false"` | Fail with exit code 2 when audit coverage is incomplete |
| `run-checks` | `"false"` | Permit execution of detected validation commands |
| `comment` | `"false"` | Post the markdown report as a pull-request comment; requires `format: markdown` and `pull-requests: write` |
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

## Reviewing pull requests

`review` narrows findings to added diff lines and prints an `APPROVE`,
`COMMENT`, or `REQUEST_CHANGES` verdict, so unrelated old issues never fail a
PR. Pair `format: markdown` with `comment: "true"` to post the review body, or
use `format: github` for inline `::error` diff annotations with no extra step:

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: subhajitlucky/codebase-doctor@main
    with:
      command: review
      base: origin/${{ github.base_ref }}
      format: markdown
      output: review.md
      fail-on: high
      comment: "true"
```

A finding on an unchanged line is out of scope for the verdict and counted as
omitted; the full `audit` still reports it. Inspect coverage before calling
the reviewed diff verified or clean.

## Notes

- The action installs the published npm package; pin `version` for reproducible runs.
- `require-complete: "true"` makes partial domain coverage a failing condition, so a "clean" result is never reported when analyzers were skipped or unsupported.
- `run-checks: "true"` executes repository-owned validation commands and should be used only on trusted code.
