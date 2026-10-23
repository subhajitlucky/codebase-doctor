import { Command } from "commander";
import type { ScanRequest } from "../core/scan.js";
import {
  addReceiptOptions,
  addScoreOptions,
  configureRepositoryCommand,
  type RepositoryCommandOptions,
} from "./scan.js";

const DEFAULT_DATABASE_TIMEOUT_MS = 10_000;
const MAX_DATABASE_TIMEOUT_MS = 3_600_000;

interface AuditCommandOptions extends RepositoryCommandOptions {
  withDatabase: boolean;
  probeDb: boolean;
  appRoles?: string;
  subjects?: string;
  ownerColumns?: string;
  probeSampleLimit: string;
  withAdvisories: boolean;
  databaseSchema: string[];
  databaseTimeout: string;
}

const DEFAULT_PROBE_OWNER_COLUMNS = [
  "owner_id",
  "user_id",
  "tenant_id",
  "account_id",
];

function parseProbeList(value: string | undefined, label: string): string[] {
  if (value === undefined) return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error(`Invalid ${label}: values must not be empty.`);
  }
  return [...new Set(entries)];
}

export interface ProbeCliOptions {
  probeDb: boolean;
  appRoles?: string;
  subjects?: string;
  ownerColumns?: string;
  probeSampleLimit: string;
}

export function buildProbeRequest(options: ProbeCliOptions): Partial<ScanRequest> {
  const appRoles = parseProbeList(options.appRoles, "app role list");
  const subjects = parseProbeList(options.subjects, "subject list");
  const ownerColumns = parseProbeList(options.ownerColumns, "owner column list");
  const hasProbeOptions =
    appRoles.length > 0 || subjects.length > 0 || ownerColumns.length > 0;
  if (options.probeDb && appRoles.length === 0) {
    throw new Error("--probe-db requires at least one --app-roles value.");
  }
  if (!options.probeDb && hasProbeOptions) {
    throw new Error("--app-roles, --subjects, and --owner-columns require --probe-db.");
  }
  if (!/^\d+$/.test(options.probeSampleLimit)) {
    throw new Error(
      `Invalid probe sample limit "${options.probeSampleLimit}": expected a positive integer.`,
    );
  }
  const sampleLimit = Number(options.probeSampleLimit);
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1) {
    throw new Error(
      `Invalid probe sample limit "${options.probeSampleLimit}": expected a positive integer.`,
    );
  }
  if (!options.probeDb) return {};
  return {
    withProbe: true,
    probeAppRoles: appRoles,
    probeSubjects: subjects,
    probeOwnerColumns: ownerColumns.length === 0
      ? DEFAULT_PROBE_OWNER_COLUMNS
      : ownerColumns,
    probeSampleLimit: sampleLimit,
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function normalizeDatabaseSchemas(schemas: readonly string[]): string[] {
  if (schemas.length === 0) return ["public"];
  const normalized = schemas.map((schema) => schema.trim());
  if (normalized.some((schema) => schema.length === 0)) {
    throw new Error("Invalid database schema: schema names cannot be empty.");
  }
  return [...new Set(normalized)];
}

export function parseDatabaseTimeout(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid database timeout "${value}": expected an integer.`);
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_DATABASE_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid database timeout "${value}": expected 1-${MAX_DATABASE_TIMEOUT_MS} ms.`,
    );
  }
  return timeoutMs;
}

function databaseRequest(options: AuditCommandOptions): Partial<ScanRequest> {
  const probe = buildProbeRequest(options);
  return {
    includeDatabaseAudit: true,
    includeSecurityAudit: true,
    withDatabase: options.withDatabase || probe.withProbe === true,
    withAdvisories: options.withAdvisories,
    databaseSchemas: normalizeDatabaseSchemas(options.databaseSchema),
    databaseTimeoutMs: parseDatabaseTimeout(options.databaseTimeout),
    ...probe,
  };
}

export function createAuditCommand(): Command {
  const command = new Command("audit")
    .description("Audit a repository with all applicable built-in modules.")
    .option(
      "--with-database",
      "permit a live PostgreSQL RLS audit using environment credentials",
      false,
    )
    .option(
      "--database-schema <schema>",
      "database schema to audit; repeatable (default: public)",
      collect,
      [],
    )
    .option(
      "--database-timeout <ms>",
      "PostgreSQL catalog statement timeout in milliseconds",
      String(DEFAULT_DATABASE_TIMEOUT_MS),
    )
    .option(
      "--with-advisories",
      "permit one opt-in OSV advisory lookup over resolved npm packages (network)",
      false,
    )
    .option(
      "--probe-db",
      "run a read-only, rolled-back behavioral RLS probe against the live database",
      false,
    )
    .option("--app-roles <roles>", "comma-separated application roles to impersonate")
    .option("--subjects <subjects>", "comma-separated Supabase subjects to simulate")
    .option("--owner-columns <columns>", "comma-separated ownership/tenant columns")
    .option("--probe-sample-limit <n>", "rows sampled per table during probing", "1000");

  return addReceiptOptions(addScoreOptions(configureRepositoryCommand<AuditCommandOptions>(command, databaseRequest)));
}
