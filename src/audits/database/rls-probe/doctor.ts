import type {
  AuditCoverage,
  Doctor,
  DoctorResult,
} from "../../../core/doctor.js";
import { formatDatabaseError, resolveConnectionString } from "../rls/redaction.js";
import { analyzeProbeResults } from "./analyzer.js";
import { mapProbeFindings } from "./mapper.js";
import { runProbes, type ProbeOptions } from "./probe.js";
import type { ProbeRunResult } from "./types.js";

const DOCTOR_ID = "database/rls-probe";
const DEFAULT_SAMPLE_LIMIT = 1_000;

export interface RlsProbeDoctorOptions {
  schemas: readonly string[];
  appRoles: readonly string[];
  subjects?: readonly string[];
  ownerColumns: readonly string[];
  sampleLimit?: number;
  statementTimeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  probe?: (options: ProbeOptions) => Promise<ProbeRunResult>;
}

function coverage(
  options: RlsProbeDoctorOptions,
  run: ProbeRunResult,
  findingsReported: number,
): AuditCoverage {
  const roleFailures = run.roleErrors.length;
  const queryErrors = run.probes.filter((probe) => probe.status === "error").length;
  const limitations: string[] = [];
  if (roleFailures > 0) {
    limitations.push(
      `${roleFailures} role(s) could not be impersonated; isolation for those roles remains unproven.`,
    );
  }
  if (queryErrors > 0) {
    limitations.push(
      `${queryErrors} probe query failure(s); isolation for those table/role pairs remains unproven.`,
    );
  }
  return {
    moduleId: DOCTOR_ID,
    status: roleFailures > 0 || queryErrors > 0 ? "partial" : "completed",
    scope: `live:${[...options.schemas].join(",")}`,
    filesExamined: 0,
    statementsExamined: run.probes.length,
    statementsRecognized: findingsReported,
    limitations,
  };
}

/** Read-only behavioral RLS probe over a live PostgreSQL/Supabase database. */
export function createRlsProbeDoctor(options: RlsProbeDoctorOptions): Doctor {
  const probe = options.probe ?? runProbes;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["network:access"],
    supports: () => options.appRoles.length > 0,
    diagnose: async (): Promise<DoctorResult> => {
      const startedAt = Date.now();
      let connectionString: string | undefined;

      try {
        if (options.appRoles.length === 0) {
          throw new Error(
            "RLS probe requires at least one application role; pass --app-roles <role>.",
          );
        }
        connectionString = resolveConnectionString(
          undefined,
          options.environment ?? process.env,
        );
        const run = await probe({
          connectionString,
          schemas: [...options.schemas],
          appRoles: [...options.appRoles],
          subjects: [...(options.subjects ?? [])],
          ownerColumns: [...options.ownerColumns],
          sampleLimit: options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT,
          statementTimeoutMs: options.statementTimeoutMs,
        });
        const report = analyzeProbeResults(run, {
          schemas: [...options.schemas],
          roles: [...options.appRoles],
        });
        const findings = mapProbeFindings(report);
        return {
          status: "completed",
          findings,
          coverage: [coverage(options, run, findings.length)],
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        throw new Error(formatDatabaseError(error, connectionString));
      }
    },
  };
}
