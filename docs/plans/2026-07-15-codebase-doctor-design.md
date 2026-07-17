# Codebase Doctor Design

> **Superseded product direction:** This historical `0.1.0` design originally
> considered a coordinator for external Doctor products. That architecture was
> rejected. This document now retains only the durable requirements and the
> decision record. Current behavior is defined by the repository README and
> architecture.

**Date:** 2026-07-15
**Status:** Superseded
**Product:** Codebase Doctor

## Summary

Codebase Doctor is a model-independent CLI that diagnoses repositories and
produces one normalized report for humans, coding agents, and CI systems.

The first release intentionally focused on bounded repository discovery,
JavaScript/TypeScript and Python validation planning, explicit check execution,
stable findings, and text/JSON reporting. The long-term product is one unified
full-codebase auditor with domain knowledge implemented as built-in modules.

## Problem

Coding agents can generate and modify software quickly, but confidence is not
proof of correctness. Compilers, tests, linters, type checkers, security tools,
database inspection, and deployment validation provide stronger evidence, yet
each ecosystem exposes different commands and output.

Developers and agents need one verification layer that can:

- understand repository and workspace structure;
- detect which internal audit modules apply;
- plan validation without silently executing target code;
- request distinct permissions for process, network, and database access;
- normalize evidence into stable findings and coverage;
- distinguish target defects from audit operational failures;
- support reproducible changed and full audits; and
- remain independent of any model provider.

## Rejected architecture

An early design described Codebase Doctor as a coordinator that would discover
external specialist Doctors and adapters. That would have required users and
agents to manage multiple installations, versions, schemas, capabilities, and
supply-chain boundaries. It also would have made Codebase Doctor dependent on
the availability and semantics of separately released products.

The project rejected that approach. Existing specialist projects may contribute
ideas, rules, fixtures, and proven analysis, but shipped domain behavior is
owned inside Codebase Doctor and exposed through its single public interface.

## Adopted product shape

```text
codebase-doctor
├── shared repository, scope, capability, finding, and report contracts
└── built-in audit modules
    ├── frontend
    ├── backend
    ├── database
    ├── security
    ├── infrastructure
    ├── performance
    └── AI systems
```

The domain names are implementation boundaries, not separately installed
Doctor products. Modules may reuse general-purpose libraries and execute
repository-owned validation commands only through the shared permission model.

## Permanent independence

> Models build. Codebase Doctor verifies.

Codebase Doctor owns diagnosis, evidence, coverage, remediation guidance, and
post-change verification. It never owns target repair. A human or separately
authorized coding agent makes a change; Codebase Doctor independently audits the
result.

There is no direct target-file write API, remediation executor, dependency
installer, Git mutation, database mutation, deployment action, or future repair
authority in the product boundary.

## Durable safety requirements

- Default repository discovery is bounded and read-only.
- Symlinks are never followed during inventory.
- Target-project commands never run without explicit `--run-checks` consent.
- Commands use argument arrays rather than shell interpolation.
- Executed checks receive bounded time/output and redacted evidence.
- Network and live database access require separate explicit permission.
- Partial, skipped, failed, unsupported, and out-of-scope work remains visible.
- Exit `2` is an operational failure and never a clean result.
- No result claims universal correctness beyond completed applicable coverage.

## Durable report contract

Every finding has a stable rule ID, Doctor/module ID, severity, confidence,
category, explanation, evidence, and fingerprint. Where applicable it also
provides impact, constraints an external fixer must preserve, and a verification
instruction.

Reports preserve:

- detected projects and planned checks;
- Doctor/module run status;
- audit scope and limitations;
- coverage completeness;
- normalized findings and summaries;
- baseline comparison; and
- deterministic text, JSON, and SARIF representations.

## Historical first-release scope

The `0.1.0` implementation sequence established:

1. A publishable TypeScript CLI.
2. Finding, evidence, fingerprint, and summary contracts.
3. Bounded workspace inventory and project detection.
4. A capability-gated internal Doctor registry.
5. Initial repository-structure rules.
6. JavaScript/TypeScript and Python validation planning.
7. Bounded subprocess execution and redaction.
8. Text/JSON reporting, CI, package verification, and an agent skill.

Later milestones added baselines, SARIF, unified live RLS, offline SQL RLS,
mixed-scope changed audits, and model-oriented finding guidance without changing
the independent-auditor boundary.

## Decision outcome

Future work expands built-in audit coverage, honest applicability/coverage
reporting, read-only MCP access, sandboxed validation, and public benchmarks.
It does not revive external Doctor products or grant Codebase Doctor repair
authority.
