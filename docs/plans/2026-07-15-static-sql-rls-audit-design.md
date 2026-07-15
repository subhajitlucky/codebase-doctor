# Static SQL/RLS Audit Design

## Status

Approved on 2026-07-15 for the `0.1.3` development milestone.

## Goal

Audit PostgreSQL Row Level Security posture directly from repository SQL without
requiring database credentials or network access. Codebase Doctor should detect
common Supabase, Prisma, Drizzle, and generic PostgreSQL migration sources,
reconstruct the supported final schema state, and emit normalized findings plus
honest coverage information.

This is an internal Codebase Doctor module, not a new CLI or package.

## Product Behavior

The normal unified command remains:

```bash
codebase-doctor audit . --json
```

Static SQL/RLS auditing runs automatically when applicable SQL sources are
visible in the repository inventory. It uses only `filesystem:read` and does not
need `--with-database`.

The live module remains separately permissioned:

```bash
codebase-doctor audit . --with-database --json
```

Static findings describe the state expected from migration code. Live findings
describe the deployed catalog. A later milestone may compare the two for drift;
the first slice keeps them distinguishable.

## Scope

### Supported sources

Within each detected project, discover PostgreSQL SQL streams under:

- `supabase/migrations/**/*.sql`
- `prisma/migrations/**/*.sql`
- `drizzle/**/*.sql`
- `migrations/**/*.sql`
- `db/migrations/**/*.sql`
- `database/migrations/**/*.sql`

A project-level `schema.sql` is a fallback stream only when no migration stream
is found for that project. Existing repository exclusions apply before SQL
discovery.

Each migration root is reduced independently. Codebase Doctor must not merge two
different tools' histories into one fictional database. Every stream has a
stable ID derived from its project and migration root.

Files inside a stream are ordered by normalized repository-relative path. This
matches timestamp- and sequence-prefixed migration conventions and remains
deterministic across operating systems.

### PostgreSQL only

The module recognizes PostgreSQL/Supabase RLS semantics. It does not claim to
audit MySQL or SQLite. A source with clearly incompatible dialect evidence is
reported as unsupported coverage, not analyzed as PostgreSQL.

Prisma and Drizzle are supported when their migration artifacts contain
PostgreSQL SQL. Their configuration formats are not parsed in the first slice.

## Approaches Considered

### Regular-expression rules

Rejected. Direct regex matching is small but unreliable around comments,
multiline statements, quoted identifiers, dollar-quoted function bodies, and
nested policy predicates. It would create false findings and unsafe confidence.

### Full third-party PostgreSQL parser

Deferred. A parser dependency increases package size and supply-chain surface,
and still cannot resolve arbitrary dynamic SQL. It may become useful after the
supported audit contract is proven.

### Conservative statement reader and state reducer

Selected. Codebase Doctor safely splits SQL, recognizes a narrow PostgreSQL DDL
subset, records unsupported relevant statements, and reports only what it can
justify.

## Architecture

```text
Project snapshot
      |
      v
SQL source discovery
      |
      v
Migration streams
      |
      v
SQL lexical splitter
      |
      v
Conservative DDL recognizer
      |
      v
Per-stream schema/RLS state reducer
      |
      +--> supported final-state facts
      +--> unsupported/ambiguous coverage facts
      |
      v
Static RLS rules and compatible live-analyzer rules
      |
      v
Codebase Doctor findings + coverage
```

Proposed internal layout:

```text
src/audits/database/sql-rls/
├── discovery.ts
├── splitter.ts
├── parser.ts
├── reducer.ts
├── analyzer.ts
├── doctor.ts
└── types.ts
```

The static module may reuse domain helpers from `audits/database/rls`, but it
must not weaken the live catalog analyzer or pretend unknown catalog facts are
known.

## SQL Splitting

The splitter is lexical, not semantic. It walks source text once and separates
statements on semicolons only when outside:

- single-quoted strings, including doubled quotes;
- double-quoted identifiers, including doubled quotes;
- line comments;
- nested block comments;
- dollar-quoted bodies with empty or named tags; and
- parenthesized expressions.

Every statement records its file, starting line, ending line, raw text, and a
normalized token view. Unterminated quotes, comments, or dollar bodies produce a
parse diagnostic and partial coverage. They do not crash the repository audit.

The splitter must never execute SQL, interpolate variables, or load included
files.

## Supported DDL

The first recognizer supports schema-qualified and quoted identifiers for:

- `CREATE TABLE` and `CREATE TABLE IF NOT EXISTS`
- `DROP TABLE`
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`
- `ALTER TABLE ... FORCE ROW LEVEL SECURITY`
- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`
- `CREATE POLICY`
- `ALTER POLICY`
- `DROP POLICY`
- table-level `GRANT` and `REVOKE` for `SELECT`, `INSERT`, `UPDATE`, `DELETE`,
  and `TRUNCATE`

`CREATE POLICY` recognizes:

- policy name and table;
- `AS PERMISSIVE` or `AS RESTRICTIVE`;
- `FOR ALL|SELECT|INSERT|UPDATE|DELETE`;
- `TO` roles;
- balanced `USING (...)`; and
- balanced `WITH CHECK (...)`.

Missing optional clauses use PostgreSQL defaults. Predicate text is preserved
for the existing unconditional-expression analysis.

The recognizer does not evaluate:

- `DO` blocks or generated/dynamic SQL;
- `EXECUTE` strings;
- functions, triggers, or views;
- psql meta-commands and included files;
- conditional migration-framework directives;
- role membership or role attributes;
- default privileges; or
- arbitrary expressions beyond structural predicate checks.

Relevant-looking but unsupported RLS or policy DDL makes the stream partial.
Unrelated DDL such as indexes and columns may be safely ignored without making
RLS coverage partial.

## State Model

Each stream reduces supported statements into a final expected state:

```ts
interface StaticTableState {
  schema: string;
  name: string;
  declaredInStream: boolean;
  dropped: boolean;
  rlsEnabled: boolean | "unknown";
  forceRls: boolean | "unknown";
  policies: StaticPolicyState[];
  grants: StaticGrantState[];
  lastEvidence: SqlLocation;
}
```

Tables created in the stream begin with RLS and FORCE RLS disabled. A referenced
pre-existing table begins with unknown state; only explicit later statements
make a property known. `DROP TABLE` removes the table from final-state findings.

Policy and grant changes apply in migration order. Unsupported renames or
dynamic references mark affected coverage partial instead of guessing object
identity.

The first slice analyzes final expected state rather than every historical
intermediate state. An earlier unsafe definition that is corrected by a later
migration does not remain a current finding. Explicit final
`DISABLE ROW LEVEL SECURITY` remains visible through final state and file
evidence.

## Static Findings

Rule IDs use the `database/sql-rls/` namespace. Initial high-signal rules are:

- table created in the stream with RLS disabled;
- explicitly granted application-facing access while RLS is disabled;
- RLS enabled with no policies;
- unconditional public-like reads;
- unconditional public-like writes;
- missing or effectively unconditional write checks;
- multiple permissive policies for one role and command;
- public-like permissive policy advisory;
- reachable `TRUNCATE` from an explicit application-facing grant; and
- FORCE RLS disabled for an RLS-enabled table, as informational hardening.

Where static facts match the live analyzer's input contract exactly, the module
may synthesize a bounded catalog snapshot and reuse those rules. Findings that
depend on unknown schema privileges, role membership, superuser attributes,
`BYPASSRLS`, ownership, or default privileges must be suppressed or lowered;
absence of those facts is not proof of safety.

Static findings use `database` evidence plus the real SQL file location. Their
fingerprint includes module ID, stream ID, rule ID, schema, table, policy when
applicable, and stable logical identity. File ordering and generated timestamps
do not affect fingerprints.

Confidence is `high` for direct supported statements and structural policy
predicates, `medium` where final-state reconstruction is complete but catalog
reachability is unknown, and never raised merely because a file name looks
familiar.

## Coverage Contract

Schema-1 reports gain an optional backward-compatible `coverage` array:

```ts
interface AuditCoverage {
  moduleId: string;
  status: "completed" | "partial" | "not-applicable" | "skipped" | "failed";
  scope: string;
  filesExamined: number;
  statementsExamined: number;
  statementsRecognized: number;
  limitations: string[];
}
```

The static module reports one entry per migration stream:

- `completed`: applicable files were read and all RLS-relevant statements were
  recognized;
- `partial`: malformed, dynamic, or unsupported relevant SQL prevents complete
  reconstruction;
- `not-applicable`: no supported SQL source exists for the project;
- `failed`: an operational read or parser failure prevented the requested audit.

The live module reports `skipped` without database permission and `completed` or
`failed` when requested. Existing `doctorRuns` remains the operational record;
coverage adds audit scope and completeness rather than replacing it.

Text, JSON, and SARIF must not describe a partial stream as clean. SARIF may
retain coverage in run properties because partial coverage is not itself a code
finding.

## Static and Live Results

The first slice does not deduplicate static and live findings. They answer
different questions and use different module IDs:

- `database/sql-rls`: expected state from repository migrations;
- `database/rls`: observed state from the live PostgreSQL catalog.

Future drift analysis can compare normalized table and policy state when both
modules completed with sufficient coverage. It must not compare against partial
static coverage.

## Error Handling and Safety

- The module is read-only and requests only `filesystem:read`.
- It reads only files already admitted by bounded repository inventory.
- A per-file size ceiling prevents unexpectedly large SQL inputs.
- Parse diagnostics are sanitized and bounded.
- One malformed stream does not erase findings from other streams.
- Unsupported SQL changes coverage, not the process exit code by itself.
- Filesystem failures become operational doctor failures when the requested
  static audit cannot complete.
- No SQL is executed and no database environment variable is read.

## Testing Strategy

Implementation follows red-green-refactor:

1. Discovery fixtures cover Supabase, Prisma, Drizzle, generic migrations,
   schema fallback, monorepos, exclusions, and independent streams.
2. Splitter tests cover comments, quotes, dollar bodies, nested expressions,
   semicolons, line numbers, malformed input, and deterministic output.
3. Parser tests cover each supported statement, quoting, defaults, balanced
   predicates, and relevant unsupported statements.
4. Reducer tests cover migration ordering, create/alter/drop behavior, policy
   replacement, grants/revokes, pre-existing unknown tables, and corrected
   historical states.
5. Analyzer tests cover severity, confidence, exact file evidence, stable
   fingerprints, and suppression of rules requiring unknown catalog facts.
6. Coverage tests verify completed, partial, not-applicable, skipped, and failed
   states in text, JSON, and SARIF.
7. CLI integration tests prove automatic offline auditing and compatibility with
   the separately permissioned live module.
8. Package and self-audit tests ensure the module ships without network access
   or new vulnerabilities.

## Non-goals for `0.1.3`

- MySQL or SQLite analysis.
- Executing migrations in a disposable database.
- Full PostgreSQL grammar coverage.
- Dynamic SQL interpretation.
- ORM configuration parsing.
- Live/static drift findings.
- Automatic SQL repair.
- Views, functions, triggers, storage policies, or hosted Supabase settings.

## Success Criteria

The milestone is complete when:

- `codebase-doctor audit .` automatically detects supported PostgreSQL migration
  streams without credentials;
- supported final RLS posture produces namespaced, evidence-backed findings;
- quoted and multiline SQL is split without regex false positives;
- unsupported relevant SQL produces partial coverage rather than false safety;
- independent migration streams remain separate;
- static and live modules coexist in one report without conflating evidence;
- existing `scan` behavior remains backward-compatible; and
- complete CI, packed installation, self-audit, dependency audit, and disposable
  integration verification pass.
