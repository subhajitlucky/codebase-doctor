import pg from "pg";
import type {
  ProbeExecutionResult,
  ProbeRoleError,
  ProbeRunResult,
  ProbeStatus,
  ProbeTarget,
} from "./types.js";

const { Client } = pg;
const DEFAULT_SAMPLE_LIMIT = 1_000;
const PROBE_SETTABLE_GUC_PREFIXES = ["request.jwt", "role", "session_authorization"];
const CURRENT_SETTING_CALL = /current_setting\s*\(\s*'([^']+)'/giu;
const SET_CONFIG_CALL = /set_config\s*\(\s*'([^']+)'/giu;

export interface ProbeOptions {
  connectionString: string;
  schemas: string[];
  appRoles: readonly string[];
  ownerColumns: readonly string[];
  subjects?: readonly string[];
  tables?: readonly string[];
  sampleLimit?: number;
  statementTimeoutMs?: number;
}

export async function runProbes(options: ProbeOptions): Promise<ProbeRunResult> {
  if (options.appRoles.length === 0) {
    throw new Error("RLS probe requires at least one application role.");
  }
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1) {
    throw new Error("RLS probe sample limit must be a positive integer.");
  }

  const client = new Client({
    connectionString: options.connectionString,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    application_name: "codebase-doctor-probe",
  });

  await client.connect();
  let transactionStarted = false;

  try {
    // A single read-only, rolled-back transaction guarantees probes never
    // mutate the audited database, even when role impersonation would
    // otherwise allow writes.
    await client.query("begin transaction isolation level repeatable read read only");
    transactionStarted = true;

    const probes: ProbeExecutionResult[] = [];
    const roleErrors: ProbeRoleError[] = [];

    const existingRoles = new Set(
      (
        await client.query<{ rolname: string }>(
          "select rolname from pg_roles where rolname = any($1)",
          [[...options.appRoles]],
        )
      ).rows.map((row) => row.rolname),
    );
    const probeRoles = options.appRoles.filter((role) => {
      if (existingRoles.has(role)) return true;
      roleErrors.push({ role, message: `role "${role}" does not exist` });
      return false;
    });

    const targets = await loadProbeTargets(client, options, probeRoles);
    const subjects: Array<string | null> = [null, ...(options.subjects ?? [])];

    for (const role of probeRoles) {
      await client.query("savepoint probe_role");
      try {
        await client.query(`set local role ${quoteIdentifier(role)}`);
      } catch (error) {
        await client.query("rollback to savepoint probe_role");
        await client.query("release savepoint probe_role");
        roleErrors.push({ role, message: errorMessage(error) });
        continue;
      }

      for (const subject of subjects) {
        await applyJwtClaims(client, subject, role);
        for (const target of targets) {
          probes.push(
            await probeTable(
              client,
              role,
              subject,
              target,
              sampleLimit,
            ),
          );
        }
      }

      await applyJwtClaims(client, null, role);
      await client.query("reset role");
      await client.query("release savepoint probe_role");
    }

    await client.query("rollback");
    transactionStarted = false;
    return { probes, roleErrors };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the probe error; connection cleanup still runs below.
      }
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function loadProbeTargets(
  client: pg.Client,
  options: ProbeOptions,
  probeRoles: readonly string[],
): Promise<ProbeTarget[]> {
  const tables = await client.query<{ schema: string; table: string }>(
    `select n.nspname as schema, c.relname as "table"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = any(array['r', 'p'])
        and n.nspname = any($1)
        and (
          c.relrowsecurity
          or exists (
            select 1
              from unnest($2::text[]) as probed_role(name)
             where has_table_privilege(probed_role.name, c.oid, 'SELECT')
          )
        )
      order by n.nspname, c.relname`,
    [[...options.schemas], [...probeRoles]],
  );

  const columns = await client.query<{ schema: string; table: string; column: string }>(
    `select table_schema as schema, table_name as "table", column_name as column
       from information_schema.columns
      where table_schema = any($1)
        and column_name = any($2)`,
    [[...options.schemas], [...options.ownerColumns]],
  );
  const ownerColumnsByTable = new Map<string, Set<string>>();
  for (const row of columns.rows) {
    const key = `${row.schema}.${row.table}`;
    const existing = ownerColumnsByTable.get(key) ?? new Set<string>();
    existing.add(row.column);
    ownerColumnsByTable.set(key, existing);
  }

  const filter = options.tables?.map((table) => table.trim()).filter((table) => table.length > 0);
  return tables.rows
    .filter((row) => {
      if (!filter || filter.length === 0) return true;
      return filter.some(
        (entry) => entry === row.table || entry === `${row.schema}.${row.table}`,
      );
    })
    .map((row) => {
      const available = ownerColumnsByTable.get(`${row.schema}.${row.table}`);
      const ownerColumn = options.ownerColumns.find((column) => available?.has(column)) ?? null;
      return { schema: row.schema, table: row.table, ownerColumn };
    });
}

async function probeTable(
  client: pg.Client,
  role: string,
  subject: string | null,
  target: ProbeTarget,
  sampleLimit: number,
): Promise<ProbeExecutionResult> {
  const qualified = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)}`;
  const base = {
    role,
    subject,
    schema: target.schema,
    table: target.table,
    ownerColumn: target.ownerColumn,
    sessionDependentSettings: await tableSessionDependency(client, target.schema, target.table),
  };

  try {
    const sampledRows = await countWithSavepoint(
      client,
      `select count(*)::text as count
         from (select 1 from ${qualified} limit ${sampleLimit}) as sample`,
    );

    let distinctOwners: number | null = null;
    let ownRows: number | null = null;
    let foreignRows: number | null = null;

    if (target.ownerColumn !== null && sampledRows > 0) {
      const column = quoteIdentifier(target.ownerColumn);
      if (subject === null) {
        distinctOwners = await countWithSavepoint(
          client,
          `select count(distinct ${column})::text as count
             from (select ${column} from ${qualified} limit ${sampleLimit}) as sample`,
        );
      } else {
        ownRows = await countWithSavepoint(
          client,
          `select count(*)::text as count
             from (select 1 from ${qualified} where (${column})::text = $1 limit ${sampleLimit}) as sample`,
          [subject],
        );
        foreignRows = await countWithSavepoint(
          client,
          `select count(*)::text as count
             from (select 1 from ${qualified} where (${column})::text is distinct from $1 limit ${sampleLimit}) as sample`,
          [subject],
        );
      }
    }

    const status: ProbeStatus = sampledRows > 0 ? "rows" : "none";
    return { ...base, status, sampledRows, distinctOwners, ownRows, foreignRows, error: null };
  } catch (error) {
    if (isPermissionDenied(error)) {
      return {
        ...base,
        status: "denied",
        sampledRows: 0,
        distinctOwners: null,
        ownRows: null,
        foreignRows: null,
        error: null,
      };
    }
    return {
      ...base,
      status: "error",
      sampledRows: 0,
      distinctOwners: null,
      ownRows: null,
      foreignRows: null,
      error: errorMessage(error),
    };
  }
}

async function tableSessionDependency(
  client: pg.Client,
  schema: string,
  table: string,
): Promise<string[]> {
  try {
    const policies = await client.query<{
      usingExpression: string | null;
      withCheckExpression: string | null;
    }>(
      `select qual as "usingExpression", with_check as "withCheckExpression"
         from pg_policies
        where schemaname = $1 and tablename = $2`,
      [schema, table],
    );
    return policiesSessionDependency(policies.rows);
  } catch {
    return [];
  }
}

async function applyJwtClaims(
  client: pg.Client,
  subject: string | null,
  role: string,
): Promise<void> {
  const claims = subject === null
    ? ""
    : JSON.stringify({ sub: subject, role, aud: "authenticated" });
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [subject ?? ""]);
}

async function countWithSavepoint(
  client: pg.Client,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  await client.query("savepoint probe_query");
  try {
    const result = await client.query<{ count: string }>(sql, [...params]);
    await client.query("release savepoint probe_query");
    return Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    await client.query("rollback to savepoint probe_query");
    await client.query("release savepoint probe_query");
    throw error;
  }
}

function collectSessionGucNames(expression: string, into: Set<string>): void {
  for (const pattern of [CURRENT_SETTING_CALL, SET_CONFIG_CALL]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(expression);
    while (match !== null) {
      const name = match[1];
      if (name !== undefined) into.add(name.toLowerCase());
      match = pattern.exec(expression);
    }
  }
}

function policiesSessionDependency(
  policies: readonly { usingExpression: string | null; withCheckExpression: string | null }[],
): string[] {
  const names = new Set<string>();
  for (const policy of policies) {
    collectSessionGucNames(policy.usingExpression ?? "", names);
    collectSessionGucNames(policy.withCheckExpression ?? "", names);
  }
  return [...names]
    .filter((name) => !PROBE_SETTABLE_GUC_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort((left, right) => left.localeCompare(right));
}

function isPermissionDenied(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "42501";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdentifier(identifier: string): string {
  if (identifier.includes("\0")) {
    throw new Error("Identifiers must not contain NUL bytes.");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}
