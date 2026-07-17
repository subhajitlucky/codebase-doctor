# Codebase Doctor Architecture

## Purpose and boundary

Codebase Doctor is one unified full-codebase auditor. It is local-first and
model-independent, combining repository inspection, configured validation,
offline SQL analysis, and an explicitly permitted live PostgreSQL audit behind
one normalized report.

> **Models build. Codebase Doctor verifies.**

Codebase Doctor exposes no direct target-file write API, has no direct
filesystem-write capability, and includes no remediation executor. It can never
be granted direct target-write or remediation authority. A human or separately
authorized external coding agent changes the target. Remediation and
verification are guidance; Doctor independently reports evidence after the
external change.

Separately authorized `--run-checks` launches repository-owned validation
subprocesses. They are not filesystem- or network-isolated and may have side
effects. That permission is validation execution, not Doctor repair authority.

The implemented safety principles are deterministic output, bounded read-only
discovery, evidence-backed findings, explicit capabilities, visible partial
failure, and honest scope. Detection is not diagnosis, and selected scope is
not evidence that unselected areas are clean.

A full audit examines the full requested repository scope for applicable
implemented modules. It does not mean complete analyzer coverage for every
domain. Consumers must inspect module runs and coverage before calling a result
verified or clean.

## Implemented audit pipeline

```text
CLI request
   |
   +--> full audit -------------------------------------------+
   |                                                          |
   +--> changed audit                                         |
          |                                                   |
          v                                                   |
      fixed read-only Git discovery                           |
      HEAD or explicit-ref merge base                         |
          |                                                   |
          v                                                   |
      changed-scope planner                                   |
      direct projects + conservative workspace dependants     |
          |                                                   |
          +---------------------------------------------------+
                              |
                              v
                    full repository snapshot
                              |
              +---------------+----------------+
              |               |                |
              v               v                v
       project doctor     check planner     SQL stream selector
       full snapshot      affected plans    affected streams
                              |                |
                              v                v
                         optional checks   offline SQL/RLS doctor
                              |                |
                              +-------+--------+
                                      |
                         optional live database doctor
                         full observed schema set
                         separate `--with-database`
                                      |
                                      v
                      normalize findings, runs, coverage,
                      plans, auditScope, and comparison
                                      |
                    +-----------------+-----------------+
                    v                 v                 v
                   text              JSON              SARIF
```

The snapshot remains repository-wide in changed mode, and Project Doctor uses
that full repository snapshot. Changed selection filters configured check plans
and static SQL streams doctor-specifically; each selected SQL stream still
replays its full current history. Live database remains a separately requested
full observed schema set through `--with-database`.

## Git discovery

`audit --changed` resolves the requested path to the Git top-level and rejects a
root mismatch. Without `--base`, `HEAD` is the audit base and discovery merges
staged, unstaged, and untracked paths. With `--base <ref>`, discovery resolves
the merge base between the ref and `HEAD`, then merges committed branch changes
from that base with staged, unstaged, and untracked paths.

The subprocess adapter runs fixed Git argument arrays with bounded output. It
does not accept arbitrary commands and is not part of the public injection API.
Invalid repositories, roots, revisions, merge bases, command results, or output
are requested-scope operational failures and produce exit `2`. Commander may
render the option as `--base [ref]` so a missing operand reaches the controlled
error path. The mode is optional, but a present `--base` requires a nonempty ref
value; a missing operand or invalid ref produces exit `2`.

Changes are deterministic and repository-relative. Rename entries contain the
new path plus `previousPath`; both locations participate in project selection.
Copy entries retain `previousPath` as evidence, but only the destination selects
scope because the source was not removed.

## Scope planning

`auditScope.mode` is `full` for the default audit and `changed` for Git-selected
audits. A changed scope records its base, normalized changes, affected project
IDs, selection reasons, and limitations.

The planner selects:

- the most specific detected project that owns each changed path;
- every project for changed repository-root context such as workspace,
  dependency, package-manager, and compiler configuration;
- conservative transitive internal Node workspace dependants, based on unique
  package names and declared dependency names.

Missing dependency metadata, unnamed Node projects, and duplicate internal
package names become limitations instead of guesses. This is a package-level
dependency graph, not a source import graph.

Changed mode is mixed-scope, not a universal file filter. Project Doctor
structural rules run with the full repository snapshot and may report findings
outside changed paths or projects for manifests, lockfiles, workspaces, and test
visibility. Configured validation command plans are created from the full
project topology and then filtered to `affectedProjectIds`. `--changed` does not
enable those checks; execution still requires `--run-checks`.

Static SQL selects affected migration streams and replays full current history
for every selected stream. Stream-wide replay is necessary to reconstruct final
state. Deleted SQL paths and paths missing from the current snapshot use
conservative historical-name or generic schema fallback when possible and
surface partial or skipped topology limitations when exact selection cannot be
proven. Dynamic SQL, malformed statements, unsupported relevant DDL, and schema
uncertainty produce partial coverage, not clean claims. Live database remains a
full observed schema-set audit only when separately requested with
`--with-database`; changed paths do not narrow its configured schema set.

Unaffected source behavior and domain checks are not broadly covered in changed
mode, although full-context structural doctors may inspect unaffected areas.
Zero changed findings is not a full clean result. Consumers must read
`auditScope`, `doctorRuns`, `coverage`, and `findings` to determine each doctor's
actual scope.

## Doctors and capabilities

The implemented Doctor capability vocabulary is read-only filesystem access,
validation process execution, and network access. It contains no direct
filesystem-write capability and exposes no direct target-file write API or
remediation executor; direct target-write or remediation authority can never be
granted to Doctor.

- Project Doctor performs built-in structural repository diagnostics.
- Check Doctor previews configured JavaScript/TypeScript and Python validation
  commands, and executes them only with `--run-checks`.
- `database/sql-rls` automatically reads inventoried PostgreSQL migration files
  and reconstructs supported expected state without credentials or SQL
  execution.
- `database/rls` performs read-only live catalog inspection only with
  `--with-database`, using schemas and credentials supplied through environment
  configuration.

`--changed` grants none of these additional capabilities. Approved project
checks are not filesystem- or network-isolated and may have target side effects,
so they require separate authorization and must not be run for an untrusted
repository. Live database access separately requires `--with-database`; schema
selection and credentials come from `--database-schema`, `DATABASE_URL`, or
`SUPABASE_DB_URL`. Reports sanitize connection failures and must never print
secrets.

## Findings and verification guidance

Every finding carries stable identity, severity, confidence, category,
explanation, structured evidence, and a fingerprint. Applicable findings add
machine-readable fields:

- `impact` explains why the evidence matters;
- `remediationConstraints` states invariants an external builder must preserve;
- `verification` names a rerun command and the expected evidence condition.

These fields are instructions for a human or external coding agent. Doctor does
not run remediation or the finding's verification command. Guidance does not
participate in fingerprint identity, so editorial improvements do not fabricate
a new logical issue. A repair is supported only when the fingerprint is absent
and all applicable coverage completed. Absence during partial, skipped, failed,
limited, or out-of-scope work is not resolution.

## Built-in secrets audit

The combined audit registers `security/secrets` as a read-only, offline Doctor.
The detector is precision-first and not exhaustive. It recognizes bounded
private-key, documented provider-token, paired AWS credential, credential-URL,
and contextual sensitive-assignment evidence without executing an external
scanner, using the network, or applying generic file-wide entropy.

Full scope is the intersection of bounded inventory and a fixed read-only Git
listing of tracked plus non-ignored files. A Git-ignored local `.env` file is
normal and is not a finding. A tracked `.env` or other repository-shareable file
can produce a finding. Changed scope reads only current added, modified, renamed,
copied, and untracked selected paths. Deleted, missing, unreadable, oversized,
or budget-truncated work becomes a limitation and partial coverage.

The raw matched value exists only as a temporary analyzer-local candidate. The
returned match contract has no value field. The value is withheld from findings
and never enters a fingerprint, digest, evidence record, message, limitation,
error, or reporter. Fingerprints use only rule, detector, safe assignment-name,
and location identity.

The module limits each file to 1 MB, total selected content to 100 MB, findings
per file to 100, and findings per audit to 1,000. Reaching a ceiling is visible
partial coverage rather than silent truncation or an unbounded model report.

Codebase Doctor never removes or rotates credentials. An external authorized
human or coding agent must remediate repository-shareable content, rotate or
revoke the credential outside Doctor, and then rerun the same scope for
independent verification.

## Normalized report contract

The normalizer copies and deterministically sorts projects, plans, doctor runs,
coverage, findings, summaries, and `auditScope`. Text, JSON, and SARIF reporters
consume that same normalized result. Operational failures stay in `doctorRuns`;
they are not fabricated findings.

### Domain coverage inventory

Every normalized result also contains `domainCoverage` in a fixed nine-domain
order: repository, validation, frontend, backend, database, security,
infrastructure, performance, and AI. The inventory separates applicability
from status. Applicability is `detected`, `not-detected`, or `unknown`; status is
`completed`, `partial`, `not-applicable`, `unsupported`, `skipped`, `failed`, or
`not-selected`.

Domain records preserve evidence, limitations, and module-level status. Domain
aggregation is conservative: for example, a completed static SQL/RLS module and
a skipped live RLS module make database coverage partial. Changed-scope modules
outside the selected impact set remain `not-selected` without erasing modules
whose contracts require full-repository context.

`coverageComplete` means only that the declared applicable, selected analysis
completed, or that non-applicability was justified. The coverageComplete field
does not mean the code is bug-free or correct. It does not guarantee that every
relevant analyzer exists and does not change exit-code behavior. Text, JSON,
and SARIF expose the same inventory so humans and models can inspect limitations
rather than infer assurance from zero findings.

JSON schema version `1` remains the report contract. `auditScope`, `coverage`,
`domainCoverage`, guidance fields, and comparison options are additive fields,
so existing schema-1 consumers remain valid. The JSON schema version is
independent from the npm package version; removing or reinterpreting existing
fields would require a schema change.

Baseline comparison uses finding fingerprints. With a baseline, failure
thresholds apply only to new findings. Changed audits set comparison to exclude
resolved fingerprints because missing current findings may simply be outside
scope. A comparable full audit can report baseline fingerprints absent from the
current full result as resolved.

## Exit behavior

| Code | Meaning |
| --- | --- |
| `0` | Requested work completed and no finding met the configured threshold. |
| `1` | Requested work completed and at least one finding met the threshold. |
| `2` | Invalid input or an operational failure prevented requested work. |

`--fail-on none` disables finding-based failure, not operational exit `2` and
not the findings themselves. Partial and skipped coverage still qualify an exit
`0` interpretation.

## Public package boundary

The package entry point exports the normalized audit, finding, coverage,
baseline comparison, Git discovery, and scope-planning contracts needed by API
consumers. `GitRunner` injection, command runners, database adapters, and other
unsafe execution internals remain private implementation details.

The npm tarball includes compiled JavaScript and declarations, README,
changelog, this architecture document, and the provider-neutral agent skill.
Package tests install the real tarball into a clean project and exercise full
and changed CLI behavior.

## Future work

The following are not implemented behavior:

- source-level import graph propagation beyond workspace package metadata;
- caching or incremental snapshot persistence;
- container, sandbox, read-only mount, or disposable-copy enforcement for
  approved checks;
- an MCP server, lifecycle-hook installer, or hosted service;
- deployment drift comparison between expected migrations and live state;
- additional built-in frontend, backend, security, infrastructure,
  performance, and AI semantic analyzers.

Future integrations must preserve the same permanent boundary: Models build.
Codebase Doctor verifies.
