import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AuditCoverage, Doctor } from "../../../core/doctor.js";
import { sortFindings, type Finding } from "../../../core/findings.js";
import type { ProjectSnapshot } from "../../../workspace/types.js";
import { analyzeStaticSqlRls } from "./analyzer.js";
import { discoverSqlStreams } from "./discovery.js";
import { parseSqlStatement } from "./parser.js";
import { reduceSqlStream } from "./reducer.js";
import { splitSql } from "./splitter.js";

const DOCTOR_ID = "database/sql-rls";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface SqlRlsDoctorOptions {
  maxFileBytes?: number;
  readSqlFile?: (root: string, path: string) => Promise<string>;
}

async function readInventoriedSqlFile(root: string, path: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const pathFromRoot = relative(absoluteRoot, absolutePath);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Refusing SQL path outside the workspace: ${path}`);
  }
  return readFile(absolutePath, "utf8");
}

function notApplicableCoverage(snapshot: ProjectSnapshot): AuditCoverage[] {
  const scopes = snapshot.projects.length === 0
    ? ["root"]
    : snapshot.projects.map(({ id }) => id).sort();
  return scopes.map((scope) => ({
    moduleId: DOCTOR_ID,
    status: "not-applicable",
    scope,
    filesExamined: 0,
    statementsExamined: 0,
    statementsRecognized: 0,
    limitations: [],
  }));
}

function validateMaxFileBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Static SQL file size limit must be a positive integer.");
  }
}

export function createSqlRlsDoctor(options: SqlRlsDoctorOptions = {}): Doctor {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  validateMaxFileBytes(maxFileBytes);
  const sqlReader = options.readSqlFile ?? readInventoriedSqlFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    diagnose: async ({ snapshot }) => {
      const startedAt = Date.now();
      const streams = discoverSqlStreams(snapshot);
      if (streams.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: notApplicableCoverage(snapshot),
          durationMs: Date.now() - startedAt,
        };
      }

      const inventory = new Map(snapshot.files.map((file) => [file.path, file]));
      const findings: Finding[] = [];
      const coverage: AuditCoverage[] = [];
      const readFailures: string[] = [];

      for (const stream of streams) {
        const statements = [];
        const limitations: string[] = [];
        let filesExamined = 0;
        let streamReadFailed = false;

        for (const path of stream.files) {
          const record = inventory.get(path);
          if (record === undefined || record.kind !== "file") {
            limitations.push(`${path}: file was not admitted by the workspace inventory.`);
            streamReadFailed = true;
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
            limitations.push(...split.diagnostics.map((diagnostic) =>
              `${diagnostic.path}:${diagnostic.line}: ${diagnostic.message}`
            ));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            limitations.push(`${path}: unable to read inventoried SQL file: ${message}`);
            readFailures.push(path);
            streamReadFailed = true;
          }
        }

        const state = reduceSqlStream(stream.id, statements.map(parseSqlStatement));
        findings.push(...analyzeStaticSqlRls(state));
        limitations.push(...state.coverage.limitations);
        coverage.push({
          moduleId: DOCTOR_ID,
          status: streamReadFailed
            ? "failed"
            : limitations.length > 0 ? "partial" : "completed",
          scope: stream.id,
          filesExamined,
          statementsExamined: state.coverage.statementsExamined,
          statementsRecognized: state.coverage.statementsRecognized,
          limitations,
        });
      }

      return {
        status: readFailures.length > 0 ? "failed" : "completed",
        findings: sortFindings(findings),
        coverage,
        ...(readFailures.length === 0 ? {} : {
          error: {
            code: "sql_file_read_failed",
            message: `Unable to read ${readFailures.length} inventoried SQL file(s).`,
          },
        }),
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
