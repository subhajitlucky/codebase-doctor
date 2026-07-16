# Codebase Doctor Design

> **Superseded product direction:** This historical `0.1.0` design describes a
> doctor-of-doctors and external adapters. That direction was rejected. The
> current product is one unified auditor with built-in modules; see
> [Unified RLS Audit Design](2026-07-15-unified-rls-audit-design.md) and the
> repository README. Retain this document only as implementation history.

**Date:** 2026-07-15  
**Status:** Superseded
**Product:** Codebase Doctor

## Summary

Codebase Doctor will be a model-independent CLI that diagnoses software repositories and provides one normalized report for humans, coding agents, and CI systems.

The long-term vision is language- and framework-independent. The first release will be intentionally narrower: universal project discovery plus explicitly approved validation checks for JavaScript/TypeScript and Python.

## Problem

Coding agents can generate and modify software quickly, but their confidence is not proof of correctness. Existing compilers, tests, linters, type-checkers, and security tools provide stronger evidence, yet every ecosystem exposes different commands and output.

Developers and agents need one verification layer that can:

- understand the shape of a repository
- select relevant diagnostic tools
- execute checks safely and transparently
- normalize results into a stable contract
- provide evidence that another agent can reproduce
- work without committing to one model vendor

## Product Position

Codebase Doctor is a **doctor-of-doctors**, not a universal parser implemented from scratch.

It adds value in four places:

1. Cross-language project and workspace discovery.
2. Safe orchestration of existing configured validation.
3. Stable findings across tools and ecosystems.
4. Agent-native output and future integration surfaces.

## Considered Approaches

### A. Build proprietary analyzers for every language

**Benefit:** maximum control over findings.  
**Cost:** years of language-specific work, duplicated mature tooling, and an unrealistic first release.

Rejected for the initial product. Purpose-built analyzers may be added only where Codebase Doctor can offer a distinct high-signal check.

### B. Wrap existing test and lint commands only

**Benefit:** fastest path to a working CLI.  
**Cost:** little differentiation, weak repository understanding, and no durable doctor ecosystem.

Rejected as the complete architecture. Existing commands remain important evidence inside the Check Doctor.

### C. Hybrid diagnostic orchestrator

**Benefit:** useful early, extensible across languages, deterministic, and suitable for agents.  
**Cost:** requires careful capability boundaries, result normalization, and honest support declarations.

Approved.

## Approved `0.1.0` Scope

### Project Doctor

- Bounded repository traversal.
- Language, framework, package manager, workspace, and monorepo detection.
- Cross-project diagnostics for invalid manifests, conflicting lockfiles, missing workspace paths, and other narrow structural inconsistencies.
- Test-file visibility reported as an informational signal.

### Check Doctor

- JavaScript/TypeScript and Python support.
- Discovery of existing configured validation commands.
- Execution only with `--run-checks`.
- No dependency installation, network permission, or repository mutation.
- Timeout, output-limit, and redaction controls.
- Normalized findings for failed checks.

### Outputs

- Human-readable terminal report.
- Versioned JSON report.
- Exit codes suitable for CI.
- Minimal filesystem-based agent skill that teaches compatible coding agents to invoke the CLI and interpret its exit codes.

### Quality Bar

- TypeScript and Node.js 20+.
- CLI built with Commander.
- Bundling with tsup.
- Unit and integration tests with Vitest.
- CI for type-checking, tests, build, package smoke tests, and dependency audit.
- MIT license before publication.

## Command Design

```bash
codebase-doctor scan [path]
```

Initial options:

```text
--run-checks          Permit execution of detected validation commands
--json                Emit machine-readable JSON
--timeout <ms>        Set the per-command timeout
--fail-on <severity>  Configure the finding threshold for exit code 1
```

Default behavior is read-only and does not spawn target-project commands.

## Safety Design

The target repository may be buggy or malicious. Therefore:

- command execution is an explicit capability
- process arguments avoid shell interpolation
- project scripts never run during read-only scans
- output and duration are bounded
- likely secrets are redacted before reporting
- missing tools produce a skip explanation rather than automatic installation
- the scanner makes no external network calls, while documentation clearly states that `0.1.0` cannot isolate networking inside an approved child process
- untrusted repository execution remains unsupported until sandboxing exists

## Agent Strategy

OpenAI and Anthropic are both building around tools, skills, hooks, permissions, MCP, and multi-agent workflows. Codebase Doctor will meet agents at those stable boundaries instead of embedding one model provider.

The integration order is:

1. CLI usable through a shell.
2. Stable JSON report.
3. Repository skill explaining when and how to scan.
4. Hook installers for post-change verification.
5. MCP server with read-only inspection and explicitly approved execution tools.
6. Independent re-verification after a human or external coding agent changes
   an isolated branch or worktree.

Core diagnosis remains deterministic at every stage.

## Success Criteria for `0.1.0`

The release is successful when:

1. `npx codebase-doctor scan .` correctly identifies representative Node and Python fixtures without executing their scripts.
2. `--run-checks` executes only the displayed, supported validation plan.
3. Passing and failing commands produce correct text, JSON, and exit codes.
4. Reports include evidence and redact configured secret fixtures.
5. Unit, integration, build, audit, and package smoke checks pass.
6. The packed npm artifact contains only required runtime files and documentation.
7. The included agent skill uses only commands and report behavior verified by CLI integration tests.
8. README claims match implemented behavior.

## Non-Goals for `0.1.0`

- Claiming complete bug detection.
- Supporting every language's executable checks.
- Installing or repairing dependencies.
- Running untrusted code in a secure sandbox.
- Editing the target repository, now or in any future release.
- Using an LLM to create findings.
- Shipping a dashboard, account system, telemetry, or billing.

## Future Product Shape

Codebase Doctor can grow into a local and CI verification standard:

```text
Universal workspace model
  + deterministic built-in doctors
  + external doctor adapters
  + diff and baseline engine
  + SARIF and pull-request reporting
  + skills, hooks, and MCP
  + independent post-change verification
```

The defensible value is not the word “doctor.” It is a trusted finding contract, safe execution, broad adapter support, low-noise diagnostics, and evidence that both humans and agents can verify.
