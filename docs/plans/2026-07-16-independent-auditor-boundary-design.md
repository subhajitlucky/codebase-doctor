# Independent Auditor Boundary Design

## Status

Approved on 2026-07-16.

## Product Principle

> Models build. Codebase Doctor verifies.

Codebase Doctor is a model-independent, whole-codebase auditor. It diagnoses,
explains, records coverage, recommends remediation, and verifies changes made by
someone else. It is not a repair agent and must never receive authority to
modify the target repository, database, infrastructure, dependencies, Git
state, or deployment.

This separation is permanent rather than a temporary limitation of `0.1.x`.
More capable coding agents increase the need for an independent verifier; they
do not justify combining the author and auditor roles.

## Responsibilities

Codebase Doctor may:

- inventory repositories and detect applicable audit areas;
- read repository evidence through bounded, declared paths;
- run explicitly approved validation commands;
- use separately approved read-only network or database access;
- produce deterministic findings, evidence, severity, confidence,
  fingerprints, remediation guidance, and coverage;
- compare results with baselines;
- rerun audits after a human or separately authorized coding agent changes the
  target; and
- expose the same verification contract through CLI, CI, skills, hooks, SARIF,
  JSON, and future read/validate-only MCP tools.

Codebase Doctor must never:

- edit, create, delete, or rename target files;
- apply patches, suggested SQL, migrations, dependency changes, or
  infrastructure changes;
- coordinate or perform repair loops;
- install target-project dependencies;
- commit, merge, push, deploy, or change Git state;
- provide an auto-fix or repair execution capability;
- receive a `filesystem:write` capability; or
- approve modifications it produced itself.

Remediation remains descriptive evidence. A human or an external coding agent
may use it to make a separately authorized change, after which Codebase Doctor
can verify the new state.

## Capability Model

The Doctor capability union contains only:

```text
filesystem:read
process:execute
network:access
```

`filesystem:write` is removed from source, tests, architecture, and future
plans. No alias or repair-specific equivalent replaces it.

`process:execute` remains an explicit validation capability, not repair
authority. Codebase Doctor displays planned commands before permission is
granted and never selects install, format, fix, migration, or deployment
commands as validation checks.

Approved repository commands are not currently filesystem- or
network-isolated. Documentation must state that they can have side effects and
must not be run for an untrusted repository. The long-term safety direction is
read-only mounts or disposable copies for validation execution, not target
write permission for Codebase Doctor.

`network:access` remains separately authorized. Live database modules use
read-only transactions and never execute remediation or migrations.

## Documentation Alignment

All product documentation uses one subject distinction:

1. Codebase Doctor finds and explains a defect.
2. A human or separately authorized external coding agent fixes it.
3. Codebase Doctor reruns the audit and verifies the result.

The README, architecture, changelog, release checklist, packaged skill, and all
implementation/design plans must follow this language. Ambiguous instructions
such as “fix a finding” must name the external actor.

Superseded historical plans remain marked as historical where appropriate, but
their repair and write-authority language is rewritten. Historical architecture
choices may remain documented only when they do not contradict the permanent
auditor boundary. A superseded document must not simultaneously present its
rejected direction as an approved current product direction.

The five-year vision is an independent verification authority with broader
built-in audit coverage, stronger sandboxed validation, honest coverage maps,
baselines, drift evidence, and attestable reports. It is not an autonomous
fixer or repair orchestrator.

## Contract Enforcement

Tests and repository checks lock the boundary:

- TypeScript rejects `filesystem:write` as a Doctor capability.
- Registry tests cover only read, execute, and network capability gates.
- Documentation contract tests require explicit external-fixer language.
- Documentation contract tests reject autonomous repair, controlled repair,
  repair-loop coordination, and future write-authority claims.
- Existing tests continue proving that SQL and database remediation is never
  executed.

The forbidden-language checks apply to product direction, not ordinary uses of
words such as bug-fix commits, test fixtures, changelog `Fixed` sections, or an
external agent fixing a finding.

## Compatibility

Removing `filesystem:write` narrows an internal TypeScript union that is not
currently granted by the runtime and is not used by any shipped doctor. No CLI
option, report schema, finding, or runtime audit behavior changes.

The JSON schema remains version `1`. Remediation fields remain backward
compatible and descriptive.

## Verification

Implementation is complete when:

1. no source or test contract contains `filesystem:write`;
2. no current or historical product document assigns repair execution or repair
   coordination to Codebase Doctor;
3. README and skill workflows explicitly identify the human or external agent
   as the fixer;
4. architecture and roadmap describe independent verification as the permanent
   five-year direction;
5. typecheck, unit and integration tests, build, package verification, and
   documentation contract tests pass; and
6. a repository-wide review finds no remaining contradictory product claim.
