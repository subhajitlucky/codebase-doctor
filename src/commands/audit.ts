import { Command } from "commander";
import type { ScanRequest } from "../core/scan.js";
import {
  configureRepositoryCommand,
  type RepositoryCommandOptions,
} from "./scan.js";

const DEFAULT_DATABASE_TIMEOUT_MS = 10_000;
const MAX_DATABASE_TIMEOUT_MS = 3_600_000;

interface AuditCommandOptions extends RepositoryCommandOptions {
  withDatabase: boolean;
  databaseSchema: string[];
  databaseTimeout: string;
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
  return {
    includeDatabaseAudit: true,
    includeSecurityAudit: true,
    withDatabase: options.withDatabase,
    databaseSchemas: normalizeDatabaseSchemas(options.databaseSchema),
    databaseTimeoutMs: parseDatabaseTimeout(options.databaseTimeout),
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
    );

  return configureRepositoryCommand<AuditCommandOptions>(command, databaseRequest);
}
