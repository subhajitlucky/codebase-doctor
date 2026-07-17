import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AuditCoverage, Doctor } from "../../../core/doctor.js";
import { sortFindings, type Finding } from "../../../core/findings.js";
import type { ProjectSnapshot } from "../../../workspace/types.js";
import { analyzeStaticSqlRls } from "./analyzer.js";
import {
  discoverSqlStreams,
  identifySqlStream,
  selectSqlStreams,
  type SqlStreamIdentity,
} from "./discovery.js";
import { parseSqlStatement } from "./parser.js";
import { reduceSqlStream } from "./reducer.js";
import { splitSql } from "./splitter.js";
import type { SqlMigrationStream } from "./types.js";

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

function changedStreamIdentities(
  snapshot: ProjectSnapshot,
  currentStreams: readonly SqlMigrationStream[],
): SqlStreamIdentity[] {
  if (snapshot.auditScope.mode === "full") return [];
  const identities = new Map<string, SqlStreamIdentity>();
  for (const change of snapshot.auditScope.changes) {
    const current = identifySqlStream(
      snapshot,
      change.path,
      currentStreams,
      change.status === "deleted",
      change.status === "deleted",
    );
    if (current !== undefined) identities.set(current.id, current);
    if (change.status === "renamed" && change.previousPath !== undefined) {
      const previous = identifySqlStream(
        snapshot,
        change.previousPath,
        currentStreams,
        true,
        true,
      );
      if (previous !== undefined) identities.set(previous.id, previous);
    }
  }
  return [...identities.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function streamsMissingHistoricalContent(
  snapshot: ProjectSnapshot,
  currentStreams: readonly SqlMigrationStream[],
): Set<string> {
  const streamIds = new Set<string>();
  if (snapshot.auditScope.mode === "full") return streamIds;
  for (const change of snapshot.auditScope.changes) {
    if (change.status === "deleted") {
      const identity = identifySqlStream(snapshot, change.path, currentStreams, true, true);
      if (identity !== undefined) streamIds.add(identity.id);
      continue;
    }
    if (change.status !== "renamed" || change.previousPath === undefined) continue;
    const previous = identifySqlStream(
      snapshot,
      change.previousPath,
      currentStreams,
      true,
      true,
    );
    const current = identifySqlStream(snapshot, change.path, currentStreams, false, false);
    if (previous !== undefined && previous.id !== current?.id) streamIds.add(previous.id);
  }
  return streamIds;
}

function changedSelectionCoverage(unselectedIds: readonly string[]): AuditCoverage | undefined {
  if (unselectedIds.length === 0) return undefined;
  return {
    moduleId: DOCTOR_ID,
    status: "skipped",
    scope: "changed:sql-stream-selection",
    filesExamined: 0,
    statementsExamined: 0,
    statementsRecognized: 0,
    limitations: [
      `Changed-scope selection examined only affected SQL streams; unselected current streams were outside affected scope: ${unselectedIds.join(", ")}.`,
    ],
  };
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
      const discoveredStreams = discoverSqlStreams(snapshot);
      if (snapshot.auditScope.mode === "full" && discoveredStreams.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: notApplicableCoverage(snapshot),
          durationMs: Date.now() - startedAt,
        };
      }

      const directlySelectedStreams = selectSqlStreams(discoveredStreams, snapshot.auditScope);
      const affectedIdentities = changedStreamIdentities(snapshot, discoveredStreams);
      const missingHistoricalContent = streamsMissingHistoricalContent(
        snapshot,
        discoveredStreams,
      );
      const historicallyAffectedProjects = new Set(affectedIdentities
        .filter(({ id, formerSchema }) =>
          formerSchema !== true && missingHistoricalContent.has(id)
        )
        .map(({ projectId }) => projectId));
      const activatedSchemaStreams = discoveredStreams.filter((stream) =>
        stream.root.toLowerCase().endsWith("schema.sql") &&
        historicallyAffectedProjects.has(stream.projectId)
      );
      const selectedIdsForTopology = new Set(directlySelectedStreams.map(({ id }) => id));
      const streams = [
        ...directlySelectedStreams,
        ...activatedSchemaStreams.filter(({ id }) => !selectedIdsForTopology.has(id)),
      ].sort((left, right) => left.root.localeCompare(right.root));
      if (
        snapshot.auditScope.mode === "changed" &&
        streams.length === 0 &&
        affectedIdentities.length === 0
      ) {
        const outsideScope = discoveredStreams.map(({ id }) => id).sort();
        const suffix = outsideScope.length === 0
          ? ""
          : ` Current stream(s) outside affected scope: ${outsideScope.join(", ")}.`;
        return {
          status: "completed",
          findings: [],
          coverage: [{
            moduleId: DOCTOR_ID,
            status: "skipped",
            scope: "changed:supported-sql-migration-streams",
            filesExamined: 0,
            statementsExamined: 0,
            statementsRecognized: 0,
            limitations: [
              `No changed supported SQL migration stream was selected.${suffix}`,
            ],
          }],
          durationMs: Date.now() - startedAt,
        };
      }

      const inventory = new Map(snapshot.files.map((file) => [file.path, file]));
      const findings: Finding[] = [];
      const coverage: AuditCoverage[] = [];
      const readFailures: string[] = [];
      const selectedIds = new Set(streams.map(({ id }) => id));
      const missingIdentities = affectedIdentities.filter(({ id }) => !selectedIds.has(id));
      const unselectedIds = discoveredStreams
        .filter(({ id }) => !selectedIds.has(id))
        .map(({ id }) => id)
        .sort();
      const selectionCoverage = snapshot.auditScope.mode === "changed"
        ? changedSelectionCoverage(unselectedIds)
        : undefined;

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
        const analysisPartial = limitations.length > 0;
        const reconstructionPartial = missingHistoricalContent.has(stream.id);
        if (reconstructionPartial) {
          limitations.push(
            "Stream includes a deleted or renamed-out migration; deleted content cannot be reconstructed from the current worktree.",
          );
        }
        coverage.push({
          moduleId: DOCTOR_ID,
          status: streamReadFailed
            ? "failed"
            : reconstructionPartial || analysisPartial
              ? "partial"
              : "completed",
          scope: stream.id,
          filesExamined,
          statementsExamined: state.coverage.statementsExamined,
          statementsRecognized: state.coverage.statementsRecognized,
          limitations,
        });
      }

      for (const identity of missingIdentities) {
        const historical = missingHistoricalContent.has(identity.id);
        const limitations = [
          identity.formerSchema === true
            ? "Prior schema fallback state cannot be reconstructed because schema.sql is absent from current discovery."
            : historical
            ? "Historical state for this deleted or renamed-out SQL migration stream cannot be reconstructed from the current worktree."
            : "No current files were discovered for this affected SQL migration stream; its state cannot be reconstructed from the current worktree.",
          ...(identity.formerSchema === true
            ? [
              "Current evidence cannot prove whether the former schema.sql was active as the fallback or suppressed by migration streams.",
            ]
            : []),
          ...(identity.inferredProject === true
            ? [
              `Former project root "${identity.projectId.slice("project:".length)}" was inferred from the supported migration path because that project is absent from the current snapshot.`,
            ]
            : []),
        ];
        coverage.push({
          moduleId: DOCTOR_ID,
          status: "partial",
          scope: identity.id,
          filesExamined: 0,
          statementsExamined: 0,
          statementsRecognized: 0,
          limitations,
        });
      }
      if (selectionCoverage !== undefined) coverage.push(selectionCoverage);
      if (snapshot.auditScope.mode === "changed") {
        coverage.sort((left, right) => left.scope.localeCompare(right.scope));
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
