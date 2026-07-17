# Agent Verification Platform Design

> **Superseded:** This document records why an early external-specialist
> architecture was rejected. It is not an implementation specification. The
> approved product is one unified full-codebase auditor whose domain knowledge
> lives in built-in modules. See the
> [Unified RLS Audit Design](2026-07-15-unified-rls-audit-design.md).

**Date:** 2026-07-15
**Status:** Superseded
**Product:** Codebase Doctor

## Durable product thesis

Codebase Doctor is a model-independent verification layer for increasingly
capable coding agents.

> Models build. Codebase Doctor verifies.

Coding agents are improving rapidly at planning, tool use, long-running work,
parallel execution, code review, and large repository changes. That increases
the amount of software they can produce, but model confidence and self-review
are not equivalent to deterministic evidence. Tests, type checks, security
analysis, database inspection, runtime validation, and explicit coverage remain
necessary.

The stable opportunity is therefore not another coding model. It is one trusted
auditor that tells any model:

- what repository and system areas were examined;
- which requested checks completed, failed, skipped, or remained partial;
- what evidence supports each finding;
- what constraints an external repair actor must preserve; and
- whether a later external change removed the finding under completed coverage.

This reasoning is independent of any named model release. Model versions and
providers will change faster than the verification contract.

## Problem that remains current

Software verification is fragmented across ecosystems and operational layers:

- repositories expose different configured commands and conventions;
- raw tool output consumes model context and uses incompatible formats;
- missing tools and operational failures are often mistaken for clean results;
- security, database, network, and process checks need distinct permissions;
- accepted findings need stable fingerprints and baseline comparison; and
- a fast changed audit must not pretend it covered unaffected behavior.

Powerful agents should invoke one stable verification interface instead of
rediscovering this plumbing for every repository.

## Rejected historical approach

The original proposal treated Codebase Doctor as a coordinator for separately
installed specialist Doctor products. RLS Doctor would have been the reference
external executable, followed by a versioned adapter protocol and independently
released frontend, backend, security, infrastructure, performance, and AI
Doctors.

That approach was rejected because it would preserve the very fragmentation the
product is meant to remove:

- agents would still need compatible specialist installations;
- users would inherit multiple trust, version, schema, and supply-chain
  boundaries;
- partial availability could vary by machine without a clear product-level
  coverage contract;
- report normalization would hide semantic differences between external tools;
  and
- the public product would become an orchestration shell rather than the owner
  of audit quality.

References below describe historical inputs, not current runtime dependencies:

- [RLS Doctor](https://github.com/subhajitlucky/rls-doctor) supplied proven
  PostgreSQL RLS analysis ideas and tests.
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  reinforces the value of rigorous agent evaluation.
- Current OpenAI and Anthropic release material demonstrates the continuing
  capability trend, but no specific model is part of the architecture.

## Adopted architecture

Codebase Doctor is one public product:

```text
human, coding agent, or CI
            |
            v
  codebase-doctor audit
            |
            v
 repository and environment detection
            |
            v
 built-in frontend, backend, database, security,
 infrastructure, performance, and AI audit modules
            |
            v
 normalized findings + scope + coverage + operational status
            |
            v
       text / JSON / SARIF / future read-only MCP
```

The module boundaries organize implementation; they are not separately
installed products. Codebase Doctor owns their compatibility, findings,
fingerprints, evidence semantics, coverage, permissions, tests, and releases.

The approved RLS milestone demonstrated this decision by migrating RLS Doctor's
useful analyzer, read-only catalog loading, redaction, and tests into the
`database/rls` built-in module. The unified runtime does not spawn or depend on
the standalone RLS Doctor package.

## Permanent safety boundary

Codebase Doctor may read bounded evidence, plan checks, run explicitly approved
validation, use separately approved read-only network/database access, and
report remediation guidance. It never edits the target, applies remediation,
installs target dependencies, mutates Git or databases, deploys, or coordinates
repair execution.

A human or separately authorized coding agent changes the target. Codebase
Doctor then reruns independently.

## Durable platform requirements

The adopted product direction retains the strongest ideas from the historical
proposal:

1. One provider-neutral command and report schema.
2. Deterministic findings with evidence and stable fingerprints.
3. Explicit capability declarations and visible operational failures.
4. Honest full, changed, partial, skipped, failed, and unsupported coverage.
5. Compact guidance optimized for model context without hiding raw evidence.
6. Read-only or disposable validation environments as the isolation direction.
7. Public defect-seeded benchmarks measuring detection, false positives,
   coverage honesty, runtime, and verification success.
8. Future MCP tools limited to inspection, audit, planning, finding lookup,
   coverage lookup, and validation—not repair.

## Historical outcome

The external-Doctor protocol and reference adapter were not implemented. Their
replacement was the built-in unified RLS audit, followed by offline static SQL
RLS analysis and Git-aware changed auditing. Future domain coverage follows the
same built-in-module pattern.
