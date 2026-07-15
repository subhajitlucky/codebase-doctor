import type { Doctor } from "../../../core/doctor.js";
import { analyzeCatalog } from "./analyzer.js";
import { loadCatalog, type LoadCatalogOptions } from "./catalog.js";
import { mapRlsReport } from "./mapper.js";
import { formatDatabaseError, resolveConnectionString } from "./redaction.js";
import type { CatalogSnapshot } from "./types.js";

export interface RlsDoctorOptions {
  schemas: readonly string[];
  statementTimeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  loadCatalog?: (options: LoadCatalogOptions) => Promise<CatalogSnapshot>;
}

export function createRlsDoctor(options: RlsDoctorOptions): Doctor {
  const catalogLoader = options.loadCatalog ?? loadCatalog;

  return {
    id: "database/rls",
    version: "0.1.0",
    capabilities: ["network:access"],
    supports: () => true,
    diagnose: async () => {
      const startedAt = Date.now();
      let connectionString: string | undefined;

      try {
        connectionString = resolveConnectionString(
          undefined,
          options.environment ?? process.env,
        );
        const schemas = [...options.schemas];
        const snapshot = await catalogLoader({
          connectionString,
          schemas,
          statementTimeoutMs: options.statementTimeoutMs,
        });
        const report = analyzeCatalog(snapshot, { schemas });

        return {
          status: "completed",
          findings: mapRlsReport(report),
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        throw new Error(formatDatabaseError(error, connectionString));
      }
    },
  };
}
