# Agent Verification Platform Design

> **Superseded:** This document records an earlier external-specialist strategy.
> Codebase Doctor is now one unified full-codebase auditor whose domain knowledge
> lives in built-in modules. Do not implement the external doctor protocol
> proposed below. The approved replacement is documented in
> [Unified RLS Audit Design](2026-07-15-unified-rls-audit-design.md).

**Date:** 2026-07-15  
**Status:** Superseded
**Product:** Codebase Doctor

## North Star

Codebase Doctor is the model-independent verification control plane that helps
autonomous coding agents produce evidence-backed, production-ready software.

It is a **doctor-of-doctors**: one trusted entry point that understands a
repository, selects relevant specialist doctors, obtains the capabilities they
need, normalizes their evidence, guides external actors with remediation
evidence, and verifies the final result after they make changes.

Codebase Doctor does not compete with increasingly capable coding models. It
gives those models a reliable way to prove that their work is correct.

## Why This Product Matters

Coding agents are becoming substantially more capable at planning, tool use,
long-running work, code review, and parallel execution.

- OpenAI's current GPT-5.6 guidance describes stronger tool-heavy workflows,
  multi-agent coordination, persisted reasoning, and higher-effort execution.
  Codex supports subagents, hooks, code review, non-interactive automation, and
  structured outputs.
- Anthropic describes Claude Sonnet 5 as its most agentic Sonnet model and
  Claude Opus 4.8 as supporting long-running dynamic workflows with large
  numbers of parallel subagents and output verification.

Sources:

- [OpenAI: Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model.md)
- [OpenAI: Codex best practices](https://learn.chatgpt.com/guides/best-practices.md)
- [OpenAI: Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Anthropic: Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5)
- [Anthropic: Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

As model capability increases, agents can create and modify more code in less
time. That increases the need for deterministic verification. Model confidence,
reasoning depth, and self-review are useful, but none is equivalent to passing
tests, type checks, security audits, database checks, or deployment validation.

## Problem

Software verification is fragmented:

- Every ecosystem exposes different commands and configuration.
- Specialist tools use incompatible report formats and exit codes.
- Raw logs consume agent context and obscure the actionable failure.
- Tool crashes, missing executables, and code findings are often conflated.
- Security and database tools need stronger permission boundaries than local
  compilation or tests.
- Agents must repeatedly rediscover which tools to run and how to interpret
  them.
- Existing repositories may contain accepted findings that should not hide new
  regressions.

Powerful agents should spend their reasoning budget fixing real defects, not
reconstructing repository-specific verification plumbing.

## Product Position

Codebase Doctor is not:

- another coding model;
- a universal static analyzer reimplemented from scratch;
- a thin script runner that treats every non-zero command alike;
- a hosted dashboard that owns customer source code;
- a claim that automated checks can prove all software behavior.

Codebase Doctor is:

1. A universal repository and project discovery layer.
2. A capability-aware orchestrator for deterministic specialist tools.
3. A stable finding, evidence, fingerprint, and operational-error contract.
4. A verification loop that agents can invoke before and after externally made
   changes.
5. A provider-neutral integration surface for skills, hooks, MCP, CI, and
   future agent systems.

## Super-Doctor Architecture

```text
Coding agent, developer, or CI
              |
              v
       Codebase Doctor
              |
              +--> discover repository and projects
              +--> select relevant specialist doctors
              +--> preview required capabilities and commands
              +--> execute approved doctors
              +--> normalize and deduplicate evidence
              +--> compare with baselines
              +--> explain remediation and support re-verification
              |
              v
  Text / JSON / SARIF / MCP / agent result
```

Specialists sit behind the core:

```text
Codebase Doctor
├── Project Doctor
├── Check Doctor
├── Frontend specialists
├── Backend specialists
├── Database specialists
│   └── RLS Doctor
├── Security specialists
├── Infrastructure specialists
├── Performance specialists
└── AI-system specialists
```

The hierarchy is a product taxonomy, not a requirement that every specialist's
source code live inside the core package.

## Core and Specialist Ownership

### Codebase Doctor core owns

- repository inventory and project boundaries;
- doctor discovery and compatibility checks;
- capability declaration and consent;
- safe process coordination;
- environment-variable allowlisting and redaction;
- doctor lifecycle and operational status;
- finding normalization and stable fingerprints;
- baseline comparison and severity thresholds;
- text, JSON, SARIF, and future MCP reporting;
- post-change audit coordination and final verification evidence.

### Specialist doctors own

- domain-specific detection and analysis;
- domain rule IDs and severities;
- evidence that supports each domain finding;
- targeted remediation guidance;
- their direct CLI or library behavior;
- independent releases and domain-specific integration tests.

Specialists may be built-in, separately published packages, executable JSON
adapters, JavaScript SDK adapters, or MCP-backed doctors. Codebase Doctor must
not silently install a specialist or hide its requested capabilities.

## Agent Experience

The ideal interaction is:

```text
Verify this repository.
```

Codebase Doctor should then:

1. Inspect the repository without executing target code.
2. Select relevant built-in and installed specialist doctors.
3. Produce a deterministic plan.
4. Run safe, policy-approved checks without unnecessary questions.
5. Request consent only when a doctor crosses a meaningful boundary.
6. Return concise normalized findings instead of raw tool noise.
7. Return one evidence-backed defect at a time for a separately authorized
   external agent or human to change.
8. Re-run affected doctors and dependent checks.
9. Return proof of what passed, failed, skipped, or could not run.

Agents should not need to remember specialist commands, manually translate
schemas, infer exit-code meanings, or investigate already accepted findings.

## Capability and Trust Model

Doctor capabilities remain explicit:

```text
filesystem:read
process:execute
network:access
```

The system should minimize friction without weakening real boundaries:

- Read-only discovery needs no repeated consent.
- Locally configured tests may run under a trusted-repository policy.
- Network access requires an explicit policy or approval.
- Secrets are forwarded only through named environment allowlists.
- Production database access is never inferred silently.
- Repository or database writes remain outside Codebase Doctor's authority.
- Destructive operations are never part of ordinary diagnosis.
- Operational failures remain distinct from product defects.

Permission profiles can eventually encode durable user or CI policy, so agents
are not repeatedly interrupted for already approved, low-risk actions.

## RLS Doctor as the First Specialist

RLS Doctor is the first official external specialist and the reference
implementation for the doctor protocol.

It remains independently published and versioned because it owns PostgreSQL and
Supabase-specific catalog analysis. Codebase Doctor owns its orchestration.

The integration should:

1. Detect an explicitly configured RLS audit or relevant Postgres/Supabase
   repository evidence.
2. Detect whether a compatible `rls-doctor` executable is available without
   installing it.
3. Show the exact audit plan during read-only discovery.
4. Declare `process:execute` and `network:access` capabilities.
5. Forward only an approved connection variable such as `DATABASE_URL` or
   `SUPABASE_DB_URL`, never print its value, and preserve RLS Doctor's own
   sanitization.
6. Invoke `rls-doctor check --json --fail-on none` for configured schemas so
   Codebase Doctor, not the child process, controls the unified threshold.
7. Validate RLS Doctor JSON schema `1.0` before trusting it.
8. Map table and schema findings into Codebase Doctor findings while preserving
   RLS rule identity, severity, evidence, recommendations, and stable table
   identity.
9. Treat a missing executable as a skip and connection or schema failures as
   operational failures.
10. Include normalized RLS findings in text, JSON, SARIF, baselines, and future
    post-change verification workflows.

The integration must never connect to a real database without explicit user or
CI authorization. A read-only or disposable database credential is preferred.

## External Doctor Protocol Direction

RLS Doctor should not be a one-off special case. It should prove a small,
versioned external-doctor protocol with these concepts:

- doctor identity and protocol version;
- compatibility and availability detection;
- required capabilities;
- deterministic plan records;
- argument-array execution without a shell;
- explicit environment-variable names, never embedded secret values;
- bounded duration and output;
- schema validation;
- normalized findings and evidence;
- operational status and skip reasons;
- stable source fingerprint preservation;
- adapter version recorded in the final report.

The first protocol should be intentionally narrow. Dynamic installation, remote
marketplaces, and target filesystem mutation remain outside the product
boundary regardless of future integrations.

## Model and Provider Independence

The verification core must not depend on OpenAI, Anthropic, or any other model
provider. Models change rapidly; deterministic software contracts should not.

Provider integrations remain thin distribution and invocation surfaces:

- repository `AGENTS.md` guidance;
- a provider-neutral `SKILL.md`;
- Codex skills, plugins, hooks, and non-interactive workflows;
- Claude Code skills, hooks, and CI workflows;
- MCP tools for discovery, planning, execution, and result retrieval;
- generic shell and JSON contracts for every other agent.

Every surface must preserve the same capability and verification rules.

## Adoption Among Coding Agents

Agents use tools that are discoverable, reliable, inexpensive in context, and
easy to invoke. Codebase Doctor should optimize for:

- one zero-guessing command;
- no installation or mutation of target dependencies;
- deterministic, low-noise findings;
- concise outputs that conserve model context;
- exact evidence and reproduction commands;
- stable JSON and SARIF contracts;
- clear distinction between defects, skips, and operational failures;
- strong defaults with configurable repository policy;
- compatibility across model vendors and agent surfaces.

Distribution should include:

- npm execution and installation;
- the shipped agent skill;
- concise `AGENTS.md` and generic-agent snippets;
- Codex and Claude Code integrations;
- a reusable GitHub Action;
- MCP server tools;
- starter-repository templates;
- framework and platform documentation;
- a doctor SDK and conformance suite once the first adapters stabilize.

## Evidence-Based Adoption

Popularity should follow measured utility, not marketing claims. Create a public
agent-verification benchmark containing representative repositories with known
defects and clean controls.

Measure:

- true findings and missed defects;
- false-positive rate;
- defects resolved by external actors after receiving a finding;
- regressions detected after externally made changes;
- tool calls and output tokens consumed;
- time from task completion to verified result;
- consistency across models and agent products;
- behavior when tools are missing or operationally unavailable.

Compare agent runs with and without Codebase Doctor using the same tasks,
repository states, permissions, and success graders. Publish the fixtures,
methodology, raw machine-readable reports, and limitations.

## Product Flywheel

```text
More high-quality specialist doctors
                |
                v
More useful normalized verification
                |
                v
More repositories and agent instructions adopt the CLI
                |
                v
More agents discover and invoke Codebase Doctor
                |
                v
More adapter authors and integrations join the ecosystem
```

The defensible value is the trusted protocol and evidence contract, not the word
"doctor" or ownership of every analyzer.

## Roadmap

### Phase 1: Trusted core — completed in current source

- deterministic repository discovery;
- capability-gated local checks;
- plan preview;
- normalized findings and operational errors;
- baselines and diff-aware thresholds;
- text, JSON, and SARIF reporting;
- provider-neutral agent skill.

### Phase 2: First specialist ecosystem — next

- external-doctor protocol version `1`;
- executable availability and compatibility detection;
- network-consent and environment allowlisting;
- RLS Doctor adapter;
- disposable integration database tests;
- adapter conformance tests and documentation.

### Phase 3: Agent-native distribution

- reusable GitHub Action;
- Codex plugin and hooks;
- Claude Code integration;
- MCP server with separate inspect, plan, and execute tools;
- concise repository instruction generators.

### Phase 4: Broader specialist catalog

- frontend and accessibility doctors;
- dependency, secrets, and infrastructure doctors;
- Go, Rust, and Java executable checks;
- third-party doctor SDK after protocol experience is sufficient.

### Phase 5: Independent verification and proof

- affected-doctor re-execution after changes;
- read-only or disposable validation environments;
- signed or attestable verification summaries where useful;
- public cross-model agent-verification benchmark;
- measured token, latency, detection, coverage, and false-positive performance.

## Success Criteria

The product direction is succeeding when:

1. An agent can verify a representative repository through one stable command.
2. Relevant specialists are selected without model-specific prompt logic.
3. Safe checks run with minimal friction and risky capabilities remain explicit.
4. Findings are concise, reproducible, low-noise, and actionable by an external
   human or coding agent.
5. A specialist failure does not erase other useful evidence.
6. RLS Doctor findings appear correctly in the unified report without leaking a
   connection string.
7. New specialists can integrate without changing the core finding schema.
8. Agent runs using Codebase Doctor show measurable improvement on published
   verification tasks.
9. README, skills, adapters, and actual CLI behavior remain contract-tested.

## Immediate Next Step

Design and implement external-doctor protocol version `1` with RLS Doctor as the
reference adapter.

The protocol design must settle these decisions before code is written:

- configuration shape and doctor discovery;
- executable version negotiation;
- network approval and permission-profile behavior;
- allowed environment-variable names;
- command planning and execution records;
- RLS JSON-to-finding mapping;
- operational-error semantics;
- protocol and adapter compatibility versioning;
- unit, conformance, CLI, and disposable-database integration tests.

This milestone is deliberately narrower than a general plugin marketplace. Its
purpose is to prove that Codebase Doctor can safely coordinate a real external
specialist end to end.
