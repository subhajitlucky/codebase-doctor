# Unified RLS Audit Design

## Status

Approved on 2026-07-15.

## Goal

Make live PostgreSQL Row Level Security auditing a built-in Codebase Doctor
capability. Users and coding agents run one Codebase Doctor command and receive
one normalized report; they do not install, invoke, or interpret a separate RLS
Doctor CLI.

## Product Boundary

Codebase Doctor is the public product and report owner. RLS is an internal audit
module alongside future frontend, backend, security, infrastructure,
performance, and AI modules.

The first unified command is:

```bash
DATABASE_URL=postgres://... codebase-doctor audit . --with-database
```

Without `--with-database`, `audit` performs the existing repository scan and
does not open a database connection. The existing `scan` command remains as a
backward-compatible repository-only interface during the transition.

Connection strings are accepted from `DATABASE_URL`, falling back to
`SUPABASE_DB_URL`. The first slice intentionally does not accept a connection
URL as a CLI option because command-line arguments can be retained in shell
history and exposed through process listings.

## Existing RLS Doctor Assessment

RLS Doctor already has a useful separation of concerns:

```text
CLI -> PostgreSQL catalog loader -> pure catalog analyzer -> reporters
```

The catalog loader reads tables, policies, relation privileges, schema
privileges, default privileges, roles, and role memberships inside a read-only,
repeatable-read transaction. The analyzer is deterministic for a supplied
catalog snapshot and understands PostgreSQL policy command semantics, privilege
reachability, role inheritance, `SET ROLE`, `SUPERUSER`, `BYPASSRLS`, default
privileges, and `TRUNCATE` exposure.

Codebase Doctor will migrate the loader, analyzer, domain types, credential
redaction, and relevant tests. It will not migrate RLS Doctor's CLI, reporters,
exit-code logic, or independent JSON schema.

Codebase Doctor will not execute `npx rls-doctor`, spawn an `rls-doctor`
executable, or depend on the `rls-doctor` npm package at runtime. The standalone
project may remain available for existing users during migration, but it is not
part of the unified execution path.

## Architecture

```text
User, agent, or CI
        |
        v
codebase-doctor audit
        |
        +--> repository inventory and project detection
        +--> built-in project audit
        +--> configured checks, when explicitly permitted
        +--> database/RLS audit, when explicitly permitted
                        |
                        v
                 catalog loader
                        |
                        v
                   RLS analyzer
        |
        v
normalized Codebase Doctor findings
        |
        +--> text
        +--> JSON schema 1
        +--> SARIF 2.1.0
```

The internal module layout is:

```text
src/audits/database/rls/
├── analyzer.ts
├── catalog.ts
├── doctor.ts
├── mapper.ts
├── redaction.ts
└── types.ts
```

`analyzer.ts` and `catalog.ts` preserve the proven RLS Doctor responsibilities.
`mapper.ts` converts its domain findings into the shared Codebase Doctor finding
contract. `doctor.ts` adapts the module to the built-in `Doctor` interface.

## Permission and Safety Model

The RLS audit declares `network:access`. The registry grants that capability
only when `--with-database` is present. It does not reuse `--run-checks` because
permission to execute repository commands is different from permission to send
credentials and queries to a database.

The module:

- uses a read-only, repeatable-read transaction;
- never executes migrations or suggested SQL;
- never calls Supabase management APIs;
- applies a configurable catalog statement timeout;
- reads credentials from the process environment only;
- redacts PostgreSQL credentials from operational errors;
- records connection or catalog failures as operational failures, not code
  findings; and
- does not claim that a partial or failed database audit is clean.

The child-command minimal environment remains separate from the database audit.
Codebase Doctor itself reads the selected connection environment variable; it
does not forward the credential to configured validation commands.

## CLI Contract

`audit` supports the current scan options plus:

```text
--with-database                  Permit the live PostgreSQL audit
--database-schema <schema>       Schema to inspect; repeatable (default: public)
--database-timeout <ms>          Catalog statement timeout (default: 10000)
```

The command deliberately avoids `--connection`. A missing `DATABASE_URL` and
`SUPABASE_DB_URL` after `--with-database` is an operational failure with exit
code `2`.

`scan` keeps its existing behavior and never enables database access. This
avoids surprising users of the stable `0.1.x` command.

## Finding Contract

RLS analyzer findings are mapped into Codebase Doctor findings:

```ts
{
  ruleId: "database/rls/public-unconditional-write",
  doctorId: "database/rls",
  severity: "critical",
  confidence: "high",
  category: "database-security",
  title: "Anonymous-style role can write rows too broadly",
  message: "...",
  evidence: [
    {
      type: "database",
      schema: "public",
      table: "documents",
      detail: "..."
    }
  ],
  remediation: "...",
  fingerprint: "..."
}
```

The shared evidence union gains a `database` variant with `schema`, optional
`table`, optional `policy`, and a redacted detail. Database findings do not
pretend to have repository file locations. SARIF records them as locationless
results while retaining their evidence in the message and properties.

RLS rule IDs are namespaced with `database/rls/`. Fingerprints use the rule ID,
schema, table or schema scope, and stable finding identity; generated timestamps
and connection strings never affect fingerprints.

Suggested SQL is preserved as remediation evidence but is never executed.

## Coverage and Failure Semantics

The normalized report includes a `database/rls` doctor run in all `audit`
reports:

- without `--with-database`: `skipped`, with an explicit permission reason;
- with permission and a supported connection: `completed`;
- with missing credentials, connection failure, timeout, or catalog failure:
  `failed`, with a sanitized operational error.

This makes coverage visible to agents. A skipped or failed RLS audit cannot be
misrepresented as a database with no findings.

The existing exit contract remains:

- `0`: all requested audits completed and no finding met the threshold;
- `1`: all requested audits completed and a finding met the threshold;
- `2`: a requested audit could not complete.

## Dependency Strategy

Codebase Doctor adds `pg` as a direct runtime dependency and `@types/pg` for
development. The implementation is owned inside this repository so the public
command does not depend on another Doctor package or its output format.

The initial migration should preserve analyzer behavior before refactoring.
After Codebase Doctor becomes the source of truth, the standalone RLS Doctor can
either be deprecated or reduced to a compatibility wrapper in a separate,
explicitly planned change.

## Testing Strategy

Implementation follows red-green-refactor:

1. Port the pure analyzer tests and make them pass without database access.
2. Test mapping into shared findings, including rule IDs, database evidence,
   remediation, deterministic fingerprints, and schema-level findings.
3. Port catalog mapping and credential-redaction tests.
4. Test capability denial, missing credentials, successful diagnosis, and
   sanitized operational failures with injected loaders.
5. Test the `audit` CLI in repository-only and database-enabled modes without a
   real database.
6. Run the existing Codebase Doctor suite to prevent report, baseline, and SARIF
   regressions.
7. Keep disposable-Docker PostgreSQL integration testing as a separate CI tier.

## Non-goals for the First Slice

- Parsing migration SQL to predict final RLS state.
- Connecting automatically merely because a database URL exists.
- Auditing views, functions, storage policies, or Supabase management settings.
- Running suggested SQL or automatically repairing policies.
- Removing or republishing the standalone RLS Doctor package.
- Building other database audit modules before the RLS contract is proven.

## Success Criteria

The slice is complete when:

- one `codebase-doctor audit` invocation can combine repository and live RLS
  findings in the normal text, JSON, and SARIF reports;
- database access occurs only after explicit permission;
- no connection secret appears in output or error messages;
- existing RLS analyzer behavior is represented by namespaced Codebase Doctor
  findings;
- skipped, completed, and failed RLS coverage is visible in `doctorRuns`; and
- existing `scan` behavior and tests remain compatible.
