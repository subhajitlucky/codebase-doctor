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
      direct projects + workspace/source dependants            |
          |                                                   |
          +---------------------------------------------------+
                              |
                              v
                    full repository snapshot
                              |
                    bounded source graph
                    changed impact paths
                              |
              +---------------+----------------+
              |               |                |
              v               v                v
       project doctor     check planner     SQL stream selector
       full snapshot      affected plans    affected streams
                              |                |
                              v                v
                         optional checks   offline database doctors
                                           Drizzle + SQL/RLS
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
package names become limitations instead of guesses. A separate bounded source
graph augments this package-level selection for supported JavaScript and
TypeScript files before doctor-specific work is selected.

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

## JavaScript, TypeScript, and Python source-impact graph

The core builds source topology before changed-scope planning and exposes it
through the finding-free `repository/source-graph` Doctor. The Doctor is
read-only and offline. It recognizes static `import`, re-export, type-only
import, literal `require`, and literal dynamic import edges with a real syntax
parser that never executes repository code. Local `tsconfig` and `jsconfig`
files contribute a deterministic subset of relative aliases and project
configuration; this is not complete Node or TypeScript module resolution.

Python `.py` files contribute statement-level `import`, `from`-imports with
relative dots, and literal `importlib.import_module`/`__import__` calls through
a bounded tokenizer that ignores comments, strings, and triple-quoted blocks.
Relative module imports resolve against the importing package to `.py` and
`__init__.py` candidates. Absolute imports resolve only when the top-level name
provably names an internal module or package under the owning project root or
its `src/` directory and exactly one candidate root exists; otherwise they are
external boundaries. Bare `from . import name` attribute imports, namespace
packages, `<module>.<attribute>` layouts, and non-literal dynamic calls are
edges without a missing-target proof or limitations, never findings.
Unterminated string literals make Python parsing partial.

Go `.go` files contribute single and block `import` declarations through a
bounded tokenizer that ignores line and block comments, interpreted strings,
raw strings, and rune literals. Each Go project's `go.mod` contributes the
module path and `replace` presence; imports under the module path resolve to
the sorted first non-test `.go` file in the target directory. Internal
packages that are absent carry the `module-internal` missing-target proof only
when no `replace` directive exists, because a replacement can redirect the
package outside the repository. `go.work`-only layouts and unreadable module
metadata are limitations; standard library and third-party paths are external
boundaries.

Java `.java` files contribute the package declaration and import statements
through a bounded tokenizer that ignores line and block comments, strings,
characters, and text blocks. Package roots are derived from standard
Maven/Gradle layouts (`src/main/java`, `src/test/java`, and `src/*/java`);
normal imports resolve to `Root/package/Class.java`, static imports fall back
from a member path to the declaring class file, and wildcard imports are never
edges (an internal wildcard becomes a limitation). Missing Java classes are
unproven internal edges or external boundaries because classes can be generated
at build time or provided by a dependency with the same package.

Rust `.rs` files contribute `mod` declarations and `use` paths through a
bounded tokenizer that ignores line comments, nested block comments, strings,
raw strings, chars, and lifetimes; brace groups are expanded into complete
paths. Crates root at `src/lib.rs` or `src/main.rs`; `crate::`, `self::`, and
`super::` paths resolve to `.rs` files or `mod.rs` directories, dropping a
trailing item segment when needed. Missing modules and use targets are unproven
internal edges because build scripts, macros, and path attributes can generate
or relocate them; internal wildcard imports become limitations.

Selection admits supported regular JavaScript, TypeScript, and Python source
files from the bounded, symlink-safe inventory. Resolution covers internal
relative, extension, index, selected alias, unique workspace-package, and
supported package-entry cases. Dynamic non-literal imports, ambiguous targets,
unsupported configuration or syntax, unreadable input, and reached graph
ceilings are coverage limitations, not findings. Cycles are valid topology and
are not findings. This topology selects conservative scope; it does not diagnose
application correctness.

The optional schema-1 `sourceImpact` object reports graph node and edge counts,
external and dynamic boundary counts, status, and limitations. Changed mode
also reports changed source roots, impacted file and project counts, a
deterministic shortest impact path for each serialized dependant, and the
`source-dependent` project-selection reason. Full counts are preserved while
impact records are bounded; `omittedImpactCount` states the difference. Full
mode reports graph coverage without inventing changed impacts.

Raw import specifiers and source text are withheld from findings, fingerprints,
coverage, limitations, and `sourceImpact`. The source graph uses no plugins,
network requests, or writes. Consumers must inspect `repository/source-graph`
coverage before calling changed source scope clean or verified. Partial or
bounded topology is not complete reachability, and an impact path is not proof
that the dependant is bug-free, buggy, or correct.

## JavaScript, TypeScript, and Python source integrity

The capability-free, read-only, offline `repository/source-integrity` Doctor
consumes the precomputed graph after scope planning. The
`repository/source-graph` Doctor remains finding-free; the separate
`repository/source-integrity` Doctor emits only
`source/import-target-missing`. This prevents topology uncertainty from being
reclassified as a correctness defect.

The Doctor is precision-first and diagnoses only four proof classes: an
explicit relative target with a supported source extension; a single
deterministic alias whose configured target explicitly names a supported source
file; a unique workspace package whose explicit entry names a supported source
file; and an internal Go package under a module path without a `replace`
directive. Python relative module imports participate as explicit relative
targets; bare-dot attribute imports and absolute internal imports without a
present file carry no missing-target proof. Extensionless, JSON, custom-loader,
conditional, ambiguous, external, and dynamic references and cycles are not
findings. It does not check named exports or validate export names.

Full mode examines all qualifying edges. Changed mode examines changed importers
and complete reverse-impacted importers. A deleted or renamed target selects its
unchanged importer. Complete changed selection is held privately;
the bounded public `sourceImpact` representation remains unchanged. Raw import
specifiers and source text are withheld from findings, fingerprints, coverage,
and reports. Safe evidence contains only normalized repository paths, import
kind, proof class, and source location.

Output is bounded to 1,000 findings per audit. Reaching that ceiling or
inheriting a graph limitation produces partial coverage. Partial coverage is
not a clean source-integrity result. An external authorized human or coding
agent must correct or restore the intended target and rerun the same scope.
Codebase Doctor does not modify or repair files.

## Drizzle postgres-js raw Date diagnostic

`database/drizzle` is an independent built-in database module alongside
`database/sql-rls` and the separately permissioned live `database/rls` Doctor.
It is read-only and offline, with `filesystem:read` as its only capability. It
never imports repository code, opens a database connection, uses the network,
or changes a query.

The pipeline is bounded and deterministic: project/source selection confirms
applicability, a bounded reader admits current regular source files, the Babel
AST analyzer resolves the imported Drizzle `sql` binding and narrow Date flow,
and finding normalization emits only safe evidence. Limits are 1 MiB per file,
50 MiB per audit, 10,000 source files, and 1,000 findings. Reached limits,
unreadable input, unsupported syntax, and unresolved value flow become partial
coverage rather than silently omitted work.

Applicability requires confirmed postgres-js through either an exact
`drizzle-orm/postgres-js` adapter import or scoped owning/workspace dependency
evidence for both `drizzle-orm` and `postgres`. Full and changed selection are
reported independently. Module states distinguish applicable completed and
partial work from not-applicable and not-selected work; a zero-finding partial
run is not clean.

The `database/drizzle/raw-sql-date-parameter` rule identifies only a statically proven Date
value: a JavaScript `Date` interpolated into raw Drizzle SQL. That path can bypass
the column's timestamp encoder, after which postgres-js may throw
`ERR_INVALID_ARG_TYPE`; equivalent SQL may work in psql because it does not use
the unencoded JavaScript parameter. `Date()`, `Date.now()`, `toISOString()`,
name-based guesses, `lte(column, date)`, and a fresh inline encoder object with
no spreads and a callable `mapToDriverValue` passed directly to `sql.param` are
not findings. Encoder identifiers, aliases, member accesses, and calls—including
objects held by `const` bindings—are partial coverage rather than assumed
safety. Unsupported or
unclassified Date flows are partial coverage limitations, not guesses.

Findings are medium severity and high confidence: the static proof is narrow,
but business impact cannot be inferred. Evidence retains only normalized path,
line, column, evidence class, and local SQL binding identity. Raw SQL, source
expressions, Date values, and secrets are withheld. Fingerprint identity uses
only safe normalized metadata; redaction does not depend on a reporter.

The remediation guidance points an external authorized human or coding agent
toward a typed comparison such as `lte(column, date)` or an explicit encoder.
Only a fresh inline callable encoder object is recognized as safe by the current
static coverage; other encoder forms remain partial. The external actor must
preserve timezone semantics and rerun the same scope. Doctor supplies evidence and verification guidance; it
never performs the repair or receives target-write authority. This permanent
separation keeps Codebase Doctor a model-independent auditor even as builder
models become more capable.

## Doctors and capabilities

The implemented Doctor capability vocabulary is read-only filesystem access,
validation process execution, and network access. It contains no direct
filesystem-write capability and exposes no direct target-file write API or
remediation executor; direct target-write or remediation authority can never be
granted to Doctor.

- Project Doctor performs built-in structural repository diagnostics.
- `repository/source-graph` supplies bounded JavaScript/TypeScript topology and
  changed-impact coverage without emitting bug findings.
- `repository/source-integrity` consumes that topology without capabilities and
  reports only provably missing supported internal source targets.
- Check Doctor previews configured JavaScript/TypeScript and Python validation
  commands, and executes them only with `--run-checks`.
- `database/drizzle` performs bounded AST analysis for confirmed postgres-js
  source and emits precision-first raw Date parameter evidence offline.
- `database/sql-rls` automatically reads inventoried PostgreSQL migration files
  and reconstructs supported expected state without credentials or SQL
  execution.
- `database/rls` performs read-only live catalog inspection only with
  `--with-database`, using schemas and credentials supplied through environment
  configuration.
- `database/rls-drift` compares reconstructed static migration state with the
  live catalog under the same `--with-database` permission: table existence, RLS
  and FORCE RLS enablement, policy names, and explicit migration grants. It
  reports unapplied migrations and live-only changes, never executes DDL, and
  turns unknown static state, out-of-selection schemas, an unavailable privilege
  catalog, and changed scope into explicit coverage limitations or not-selected
  records rather than guessed findings.

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

## Built-in history secrets audit

The combined audit also registers `security/secrets-history`, a read-only,
offline Doctor over recent Git history. It runs fixed `git log` read commands
scoped to the audited subtree, parses added patch lines, and reuses the
`security/secrets` analyzers so a credential deleted from the working tree but
still reachable in commits is reported with its commit and path while the value
stays withheld. It never checks out, rewrites, or executes repository content.

A history match whose detector still matches current tracked content is
suppressed because `security/secrets` already reports it. History scanning is
bounded to the most recent 200 commits across all branches and 20 MB of patch
output; an unavailable repository, truncated patch stream, or unreadable current
file becomes a coverage limitation, never a clean result. Changed audits report
`not-selected`. Remediation requires an external rotation or revocation first
and an authorized history-rewriting workflow; the Doctor never rewrites history.

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

## Built-in dependency audit

The combined audit registers `security/dependencies` as a read-only, offline
Doctor immediately after `security/secrets`. It supports npm lockfile versions
2 and 3. Projects that declare or expose pnpm, Yarn, or Bun lock authority are
covered by a cross-ecosystem path: `pnpm-lock.yaml` (v5+), `yarn.lock` (v1 and
Berry), and text `bun.lock` are parsed for resolved sources, integrity or
checksum evidence, and the manifest ranges the lock actually records. Python
and other dependency ecosystems remain unsupported coverage; the Doctor does not
guess their graph state.

The module never invokes npm or another package manager, never launches a shell,
installer, or lifecycle script, and never uses the network. It reads only
inventoried regular `package.json`, `package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, and `bun.lock` metadata,
plus the governed `package.json` manifests for those roots. Lockfile reads are
limited to 20 MB each and 100 MB per audit; output is limited to 100 findings
per lock root and 1,000 per audit. Every ceiling or read/parse limitation
produces partial coverage.

Full selection groups standalone npm projects and workspace members under their
governing npm lock root, with nested independent locks analyzed separately.
`npm-shrinkwrap.json` takes precedence when both npm lock forms exist. The
cross-ecosystem path groups Node projects under the nearest root that exposes a
non-npm lockfile, prefers the declared `packageManager` lockfile, reports other
lockfiles at the same root as `competing-lockfiles`, and withholds drift claims
when multiple non-npm lockfiles exist without a declared manager. Yarn
descriptor keys include transitive ranges, so reverse drift is restricted to
pnpm importer and Bun workspace records. Changed selection analyzes affected
projects with their governing lock root and reports unrelated dependency graphs
as not-selected.

The implemented high-confidence rule families are:

- `security/dependencies/missing-lockfile`
- `security/dependencies/manifest-lock-drift`
- `security/dependencies/insecure-source`
- `security/dependencies/mutable-git-source`
- `security/dependencies/missing-integrity`
- `security/dependencies/workspace-registry-resolution`
- `security/dependencies/competing-npm-lockfiles`
- `security/dependencies/competing-lockfiles`

Exact manifest/lock comparison does not resolve semver. A normal semver range is
not a finding when the supported lock metadata agrees. Source and integrity
rules for pnpm, Yarn, and Bun reuse the same classifier as npm; a lock entry
whose source is not integrity-bearing (git, file, link, workspace) is never
reported as missing integrity. The module makes no CVE
or current advisory claim because it has no current advisory source.

Raw dependency specifications and resolved URLs are analyzer-local, withheld
from returned metadata, and never enter a fingerprint, finding, evidence,
limitation, error, or reporter. A private graph-associated equality check lets
drift analysis compare exact strings without returning or hashing those values.

An external authorized human or coding agent must correct or regenerate the
dependency metadata and rerun the same scope. Doctor never performs that
remediation. Consumers must inspect both `security/secrets` and
`security/dependencies` coverage before calling security clean or verified;
completed plus partial, unsupported, failed, or not-selected module work is
conservatively incomplete at the security-domain level.

## Built-in agent-surface audit

The combined audit registers `ai/agent-surface` as a read-only, offline Doctor
over the repository's agent configuration surface. It reads only inventoried
regular files bounded to 1 MB each, 50 MB per audit, and 200 files. Nothing on
this surface is executed, no server is contacted, and no suspected credential
value is printed or fingerprinted.

MCP client configurations contribute unpinned package runners, shell commands,
inline credential keys with the value withheld, and broad filesystem grants.
`SKILL.md` frontmatter must declare non-empty `name` and `description`, and
unscoped `allowed-tools` entries (`Bash(*)`, bare `Bash`, `Write`, `Edit`) are
reported because they pre-approve every invocation of that tool. Documented
permission settings are interpreted for known clients only: Claude Code
`permissions.defaultMode: bypassPermissions`, unscoped `permissions.allow`
rules, and hook `command` entries (command text withheld); VS Code
`chat.tools.autoApprove`; and Aider `yes-always` or `yes`. Instruction and
prompt files are reported only when a permission-bypass flag such as
`--dangerously-skip-permissions` or `--yolo` appears inside a fenced code block
or inline code span, so prose warnings are not findings. Malformed
configuration stays visible as a coverage limitation, never a guessed finding.

## Precision and bounded-report contract

Workspace publication entries, generated targets, and fixture-controlled paths
are coverage limitations unless independently proven broken; they are not
missing-target findings by themselves. Detected pnpm, Yarn, and Bun scopes never
receive npm-specific findings. Only a cryptographic match to an inventoried
localhost-only certificate can classify a private key as an intentional local
test key; every other matched private key remains a high-severity finding.

Schema-1 reports bound repeated evidence without hiding its size.
`coverageSummary` preserves exact `total`, `emitted`, and `omitted` record counts.
`limitationGroups` preserve each fixed reason, deterministic sample paths, and
the number of omitted paths. These additions do not redefine findings or their
fingerprints. Codebase Doctor never modifies, fixes, or repairs target files.

## Normalized report contract

The normalizer copies and deterministically sorts projects, plans, doctor runs,
coverage, findings, summaries, `auditScope`, and optional `sourceImpact`. Text,
JSON, and SARIF reporters consume that same normalized result. Operational
failures stay in `doctorRuns`; they are not fabricated findings.

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

JSON schema version `1` remains the report contract. `auditScope`, optional
`sourceImpact`, `coverage`, `domainCoverage`, guidance fields, and comparison
options are additive fields, so existing schema-1 consumers remain valid. The
JSON schema version is independent from the npm package version; removing or
reinterpreting existing fields would require a schema change.

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

## Model Context Protocol server

The `codebase-doctor mcp` subcommand serves the same normalized audit over an
MCP stdio transport for coding agents. It exposes two read-only tools:
`audit_codebase` runs the public programmatic audit API with path,
json-or-summary format, and changed/base passthrough while bounding oversized
responses at roughly 50 KB with an explicit note, and
`describe_capabilities` reads tool, domain, and capability metadata. The
server never enables validation commands or live database access, performs no
writes, and preserves the permanent boundary: Models build. Codebase Doctor
verifies.

## Public package boundary

The package entry point exports the normalized audit, finding, coverage,
baseline comparison, Git discovery, and scope-planning contracts needed by API
consumers. It also exposes the safe additive `SourceGraphEdge` and
`MissingTargetProof` types, but not private complete-impact selection.
`GitRunner` injection, command runners, database adapters, and other unsafe
execution internals remain private implementation details.

The npm tarball includes compiled JavaScript and declarations, README,
changelog, this architecture document, and the provider-neutral agent skill.
Package tests install the real tarball into a clean project and exercise full
and changed CLI behavior.

## Future work

The following are not implemented behavior:

- source topology beyond the current deterministic JavaScript/TypeScript subset,
  including additional languages and explicitly bounded resolution semantics;
- caching or incremental snapshot persistence;
- container, sandbox, read-only mount, or disposable-copy enforcement for
  approved checks;
- a lifecycle-hook installer or hosted service;
- deployment drift comparison between expected migrations and live state;
- additional built-in frontend, backend, security, infrastructure,
  performance, and AI semantic analyzers.

Future integrations must preserve the same permanent boundary: Models build.
Codebase Doctor verifies.
