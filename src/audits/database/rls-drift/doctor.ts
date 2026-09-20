import type { AuditCoverage, Doctor } from "../../../core/doctor.js";
import {
  createFingerprint,
  sortFindings,
  type Evidence,
  type Finding,
} from "../../../core/findings.js";
import { discoverSqlStreams } from "../sql-rls/discovery.js";
import { readInventoriedSqlFile } from "../sql-rls/doctor.js";
import { parseSqlStatement } from "../sql-rls/parser.js";
import { reduceSqlStream } from "../sql-rls/reducer.js";
import { splitSql } from "../sql-rls/splitter.js";
import type {
  SqlMigrationStream,
  SqlStatement,
  SqlStreamState,
  StaticTableState,
} from "../sql-rls/types.js";
import { loadCatalog, type LoadCatalogOptions } from "../rls/catalog.js";
import { formatDatabaseError, resolveConnectionString } from "../rls/redaction.js";
import type { CatalogSnapshot, PolicySnapshot } from "../rls/types.js";

const DOCTOR_ID = "database/rls-drift";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface RlsDriftDoctorOptions {
  schemas: readonly string[];
  statementTimeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  loadCatalog?: (options: LoadCatalogOptions) => Promise<CatalogSnapshot>;
  maxFileBytes?: number;
  readSqlFile?: (root: string, path: string) => Promise<string>;
}

export interface StreamComparisonInput {
  stream: SqlMigrationStream;
  state: SqlStreamState;
  live: CatalogSnapshot;
  liveSchemas: readonly string[];
}

export interface StreamComparisonResult {
  findings: Finding[];
  limitations: string[];
}

function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

function displayTable(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function normalizeRole(role: string): string {
  const unquoted = role.startsWith('"') && role.endsWith('"') && role.length > 1
    ? role.slice(1, -1)
    : role;
  return unquoted.toLowerCase() === "public" ? "PUBLIC" : unquoted;
}

function locationOf(statement: SqlStatement | undefined): { path: string; line: number } | undefined {
  if (statement === undefined) return undefined;
  return { path: statement.path, line: statement.startLine };
}

function driftFinding(input: {
  ruleId: string;
  severity: Finding["severity"];
  title: string;
  message: string;
  streamId: string;
  identity: string;
  location?: { path: string; line: number } | undefined;
  evidence: readonly Evidence[];
}): Finding {
  return {
    ruleId: `${DOCTOR_ID}/${input.ruleId}`,
    doctorId: DOCTOR_ID,
    severity: input.severity,
    confidence: "high",
    category: "database",
    title: input.title,
    message: input.message,
    ...(input.location === undefined ? {} : { location: input.location }),
    evidence: input.evidence,
    impact:
      "Schema changes applied outside the migration stream make the repository an unreliable description of production and can silently weaken row level security.",
    remediationConstraints: [
      "Reconcile the live database through the repository's authorized migration and migration-review workflow.",
      "Codebase Doctor never executes DDL; an external authorized human or agent must apply the decision.",
    ],
    remediation:
      "Apply the missing or divergent migration to the live database, or update the migration stream to match the intended state, then rerun the same audit with --with-database.",
    verification: {
      command: "codebase-doctor audit . --with-database",
      expected:
        "The finding fingerprint is absent and database/rls-drift coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${input.ruleId}`,
      ...(input.location === undefined ? {} : { location: input.location }),
      identity: `${input.streamId}|${input.identity}`,
    }),
  };
}

/**
 * Compares reconstructed static migration state with the live catalog. Only
 * dimensions where both sides are known are compared; unknown static state,
 * unavailable live privileges, and schemas outside the live selection become
 * coverage limitations instead of guessed findings.
 */
export function compareStreamToLive(input: StreamComparisonInput): StreamComparisonResult {
  const { stream, state, live, liveSchemas } = input;
  const findings: Finding[] = [];
  const limitations: string[] = [];
  const liveSchemaKeys = new Set(liveSchemas.map((schema) => schema.toLowerCase()));

  const liveTables = new Map<string, CatalogSnapshot["tables"][number]>();
  for (const table of live.tables) {
    liveTables.set(tableKey(table.schema, table.name), table);
  }

  const livePolicies = new Map<string, Map<string, PolicySnapshot>>();
  for (const policy of live.policies) {
    const key = tableKey(policy.schema, policy.table);
    const byName = livePolicies.get(key) ?? new Map<string, PolicySnapshot>();
    byName.set(policy.name, policy);
    livePolicies.set(key, byName);
  }

  const livePrivileges = live.relationPrivileges === undefined
    ? undefined
    : new Map<string, Set<string>>();
  if (livePrivileges !== undefined) {
    for (const privilege of live.relationPrivileges!) {
      const key = tableKey(privilege.schema, privilege.table);
      const grants = livePrivileges.get(key) ?? new Set<string>();
      grants.add(`${normalizeRole(privilege.grantee)}\u0000${privilege.privilege}`);
      livePrivileges.set(key, grants);
    }
  } else {
    limitations.push(
      "The live catalog did not return relation privileges, so static grants were not compared.",
    );
  }

  for (const table of state.tables) {
    if (table.dropped) continue;
    const shown = displayTable(table.schema, table.name);
    if (!liveSchemaKeys.has(table.schema.toLowerCase())) {
      limitations.push(
        `${shown}: schema is outside the live audit schema selection (${[...liveSchemas].join(", ")}); drift comparison was skipped for this table.`,
      );
      continue;
    }

    const key = tableKey(table.schema, table.name);
    const liveTable = liveTables.get(key);
    if (liveTable === undefined) {
      const declared = table.declaredInStream;
      findings.push(driftFinding({
        ruleId: "table-missing-live",
        severity: declared ? "high" : "medium",
        title: "Table is missing from the live database",
        message: declared
          ? `Table ${shown} is declared in the selected migration stream but is absent from the live catalog.`
          : `Table ${shown} is referenced by the selected migration stream but is absent from the live catalog.`,
        streamId: stream.id,
        identity: `${key}|table`,
        location: locationOf(table.lastEvidence),
        evidence: [
          { type: "file", path: table.lastEvidence.path, detail: `migration statement referencing ${shown}` },
          { type: "database", schema: table.schema, table: table.name, detail: "table absent from the live catalog" },
        ],
      }));
      continue;
    }

    if (table.rlsEnabled === "unknown") {
      limitations.push(
        `${shown}: RLS enablement could not be reconstructed from static SQL, so live comparison was skipped for that dimension.`,
      );
    } else if (table.rlsEnabled && !liveTable.rlsEnabled) {
      findings.push(driftFinding({
        ruleId: "rls-disabled-live",
        severity: "high",
        title: "Live RLS state disagrees with the migration stream",
        message: `The migration stream enables row level security on ${shown}, but the live catalog reports it disabled.`,
        streamId: stream.id,
        identity: `${key}|rls`,
        location: locationOf(table.rlsEvidence ?? table.lastEvidence),
        evidence: [
          { type: "file", path: (table.rlsEvidence ?? table.lastEvidence).path, detail: `migration enables RLS on ${shown}` },
          { type: "database", schema: table.schema, table: table.name, detail: "RLS disabled in the live catalog" },
        ],
      }));
    } else if (!table.rlsEnabled && liveTable.rlsEnabled) {
      findings.push(driftFinding({
        ruleId: "rls-enabled-live-only",
        severity: "medium",
        title: "Live RLS state is not represented in the migration stream",
        message: `The live catalog reports row level security enabled on ${shown}, but the migration stream leaves it disabled.`,
        streamId: stream.id,
        identity: `${key}|rls`,
        location: locationOf(table.lastEvidence),
        evidence: [
          { type: "file", path: table.lastEvidence.path, detail: `migration state for ${shown}` },
          { type: "database", schema: table.schema, table: table.name, detail: "RLS enabled in the live catalog" },
        ],
      }));
    }

    if (table.forceRls === "unknown") {
      limitations.push(
        `${shown}: FORCE ROW LEVEL SECURITY could not be reconstructed from static SQL, so live comparison was skipped for that dimension.`,
      );
    } else if (table.forceRls && !liveTable.forceRls) {
      findings.push(driftFinding({
        ruleId: "force-rls-disabled-live",
        severity: "high",
        title: "Force RLS state disagrees with the migration stream",
        message: `The migration stream forces row level security on ${shown}, but the live catalog reports it not forced.`,
        streamId: stream.id,
        identity: `${key}|force-rls`,
        location: locationOf(table.forceRlsEvidence ?? table.rlsEvidence ?? table.lastEvidence),
        evidence: [
          {
            type: "file",
            path: (table.forceRlsEvidence ?? table.rlsEvidence ?? table.lastEvidence).path,
            detail: `migration forces RLS on ${shown}`,
          },
          { type: "database", schema: table.schema, table: table.name, detail: "RLS not forced in the live catalog" },
        ],
      }));
    }

    comparePolicies(table, key, shown, stream, livePolicies.get(key), findings, limitations);

    if (table.grantsComplete) {
      if (livePrivileges !== undefined) {
        const observed = livePrivileges.get(key) ?? new Set<string>();
        for (const grant of table.grants) {
          const role = normalizeRole(grant.role);
          if (observed.has(`${role}\u0000${grant.privilege}`)) continue;
          findings.push(driftFinding({
            ruleId: "grant-missing-live",
            severity: "medium",
            title: "Migration grant is missing from the live database",
            message: `The migration stream grants ${grant.privilege} on ${shown} to ${role}, but the live catalog does not report that grant.`,
            streamId: stream.id,
            identity: `${key}|grant|${role}|${grant.privilege}`,
            location: locationOf(grant.evidence),
            evidence: [
              { type: "file", path: grant.evidence.path, detail: `migration grants ${grant.privilege} to ${role}` },
              {
                type: "database",
                schema: table.schema,
                table: table.name,
                detail: `${grant.privilege} to ${role} absent from live relation privileges`,
              },
            ],
          }));
        }
      }
    } else {
      limitations.push(
        `${shown}: static grant state is incomplete, so grants were not compared.`,
      );
    }
  }

  return { findings: sortFindings(findings), limitations };
}

function comparePolicies(
  table: StaticTableState,
  key: string,
  shown: string,
  stream: SqlMigrationStream,
  liveForTable: Map<string, PolicySnapshot> | undefined,
  findings: Finding[],
  limitations: string[],
): void {
  if (!table.policiesComplete) {
    limitations.push(
      `${shown}: static policy state is incomplete, so policies were not compared.`,
    );
    return;
  }

  const staticNames = new Set(table.policies.map((policy) => policy.name));
  for (const policy of table.policies) {
    if (liveForTable?.has(policy.name) === true) continue;
    findings.push(driftFinding({
      ruleId: "policy-missing-live",
      severity: "high",
      title: "Migration policy is missing from the live database",
      message: `Policy ${policy.name} on ${shown} exists in the selected migration stream but not in the live catalog.`,
      streamId: stream.id,
      identity: `${key}|policy|${policy.name}`,
      location: locationOf(policy.evidence),
      evidence: [
        { type: "file", path: policy.evidence.path, detail: `migration declares policy ${policy.name}` },
        {
          type: "database",
          schema: table.schema,
          table: table.name,
          policy: policy.name,
          detail: "policy absent from the live catalog",
        },
      ],
    }));
  }

  for (const livePolicy of liveForTable?.values() ?? []) {
    if (staticNames.has(livePolicy.name)) continue;
    findings.push(driftFinding({
      ruleId: "policy-unmanaged-live",
      severity: "medium",
      title: "Live policy is not represented in the migration stream",
      message: `Policy ${livePolicy.name} exists on ${shown} in the live catalog but not in the selected migration stream.`,
      streamId: stream.id,
      identity: `${key}|live-policy|${livePolicy.name}`,
      location: locationOf(table.lastEvidence),
      evidence: [
        { type: "file", path: table.lastEvidence.path, detail: `migration state for ${shown}` },
        {
          type: "database",
          schema: table.schema,
          table: table.name,
          policy: livePolicy.name,
          detail: "policy present only in the live catalog",
        },
      ],
    }));
  }
}

function notSelectedCoverage(): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status: "not-selected",
    scope: "changed",
    filesExamined: 0,
    statementsExamined: 0,
    statementsRecognized: 0,
    limitations: [
      "Drift comparison is not selected for changed audits; run a full audit with --with-database for static-to-live comparison.",
    ],
  };
}

/**
 * Compares reconstructed static migration state with the live database catalog
 * for table existence, RLS and force-RLS enablement, policy names, and explicit
 * migration grants. Requires live database access; never executes DDL.
 */
export function createRlsDriftDoctor(options: RlsDriftDoctorOptions): Doctor {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const catalogLoader = options.loadCatalog ?? loadCatalog;
  const sqlReader = options.readSqlFile ?? readInventoriedSqlFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["network:access"],
    supports: (snapshot) => discoverSqlStreams(snapshot).length > 0,
    diagnose: async ({ snapshot }) => {
      const startedAt = Date.now();

      if (snapshot.auditScope.mode === "changed") {
        return {
          status: "completed",
          findings: [],
          coverage: [notSelectedCoverage()],
          durationMs: Date.now() - startedAt,
        };
      }

      const streams = discoverSqlStreams(snapshot).sort((left, right) =>
        left.root.localeCompare(right.root)
      );
      const inventory = new Map(snapshot.files.map((file) => [file.path, file]));
      const prepared: Array<{
        stream: SqlMigrationStream;
        state: SqlStreamState;
        filesExamined: number;
        limitations: string[];
      }> = [];

      for (const stream of streams) {
        const statements = [];
        const limitations: string[] = [];
        let filesExamined = 0;
        for (const path of stream.files) {
          const record = inventory.get(path);
          if (record === undefined || record.kind !== "file") {
            limitations.push(`${path}: file was not admitted by the workspace inventory.`);
            continue;
          }
          if (record.size > maxFileBytes) {
            limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte static SQL size limit.`);
            continue;
          }
          try {
            const source = await sqlReader(snapshot.root, path);
            filesExamined += 1;
            const split = splitSql(path, source);
            statements.push(...split.statements);
            limitations.push(...split.diagnostics.map(
              (diagnostic) => `${diagnostic.path}:${diagnostic.line}: ${diagnostic.message}`,
            ));
          } catch (error) {
            limitations.push(
              `${path}: unable to read inventoried SQL file: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        prepared.push({
          stream,
          state: reduceSqlStream(stream.id, statements.map(parseSqlStatement)),
          filesExamined,
          limitations,
        });
      }

      let connectionString: string | undefined;
      let live: CatalogSnapshot;
      try {
        connectionString = resolveConnectionString(
          undefined,
          options.environment ?? process.env,
        );
        live = await catalogLoader({
          connectionString,
          schemas: [...options.schemas],
          statementTimeoutMs: options.statementTimeoutMs,
        });
      } catch (error) {
        throw new Error(formatDatabaseError(error, connectionString));
      }

      const findings: Finding[] = [];
      const coverage: AuditCoverage[] = [];
      for (const { stream, state, filesExamined, limitations } of prepared) {
        const comparison = compareStreamToLive({
          stream,
          state,
          live,
          liveSchemas: options.schemas,
        });
        findings.push(...comparison.findings);
        const streamLimitations = [
          ...limitations,
          ...state.coverage.limitations,
          ...comparison.limitations,
        ];
        coverage.push({
          moduleId: DOCTOR_ID,
          status:
            state.coverage.status === "partial" ||
            limitations.length > 0 ||
            comparison.limitations.length > 0
              ? "partial"
              : "completed",
          scope: stream.id,
          filesExamined,
          statementsExamined: state.coverage.statementsExamined,
          statementsRecognized: state.coverage.statementsRecognized,
          limitations: [...new Set(streamLimitations)].sort(),
        });
      }

      return {
        status: "completed",
        findings: sortFindings(findings),
        coverage,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
