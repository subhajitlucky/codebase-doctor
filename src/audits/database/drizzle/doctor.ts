import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { boundLimitations } from "../../../core/bounded-evidence.js";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import {
  createFingerprint,
  sortFindings,
  type Finding,
} from "../../../core/findings.js";
import type { DetectedProject, FileRecord, ProjectSnapshot } from "../../../workspace/types.js";
import {
  analyzeDrizzlePostgresJsAdapterImport,
  analyzeDrizzleRawSqlDates,
} from "./analyzer.js";
import {
  DEFAULT_MAX_DRIZZLE_FILES,
  selectDrizzleAuditFiles,
} from "./selection.js";
import type {
  DrizzleAnalysisLimitation,
  DrizzleDateMatch,
} from "./types.js";

const DOCTOR_ID = "database/drizzle";
const RULE_ID = "database/drizzle/raw-sql-date-parameter";
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_MAX_TOTAL_BYTES = 52_428_800;
const DEFAULT_MAX_FINDINGS = 1_000;
const SUPPORTED_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/iu;

export interface DrizzleDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
  readonly maxFindings?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function supportedRegularFile(file: FileRecord): boolean {
  return file.kind === "file" && SUPPORTED_SOURCE_EXTENSION.test(file.path);
}

function owns(project: DetectedProject, path: string): boolean {
  return project.root === "." || path === project.root || path.startsWith(`${project.root}/`);
}

function uniqueOwner(snapshot: ProjectSnapshot, path: string): DetectedProject | undefined {
  const owners = snapshot.projects.filter((project) => owns(project, path));
  if (owners.length === 0) return undefined;
  const deepest = Math.max(...owners.map(({ root }) => root === "." ? 0 : root.length));
  const candidates = owners.filter(({ root }) => (root === "." ? 0 : root.length) === deepest);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function discoveryFiles(snapshot: ProjectSnapshot): FileRecord[] {
  const affected = new Set(snapshot.auditScope.affectedProjectIds);
  return snapshot.files
    .filter(supportedRegularFile)
    .filter((file) => {
      const owner = uniqueOwner(snapshot, file.path);
      return owner !== undefined &&
        (snapshot.auditScope.mode === "full" || affected.has(owner.id));
    })
    .sort((left, right) => compareCodePoints(left.path, right.path));
}

function safeAbsolutePath(root: string, path: string): string | undefined {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const fromRoot = relative(absoluteRoot, absolutePath);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  return absolutePath;
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.endsWith("\n")
    ? source.slice(0, -1).split(/\r?\n/u).length
    : source.split(/\r?\n/u).length;
}

function findingFor(
  path: string,
  match: DrizzleDateMatch,
  changed: boolean,
): Finding {
  const location = { path, line: match.line, column: match.column };
  return {
    ruleId: RULE_ID,
    doctorId: DOCTOR_ID,
    severity: "medium",
    confidence: "high",
    category: "database",
    title: "Raw Drizzle SQL receives an unencoded Date value",
    message:
      "A statically proven JavaScript Date is interpolated directly into a Drizzle raw SQL template on a confirmed postgres-js path. Raw SQL may bypass the timestamp column encoder.",
    location,
    evidence: [{
      type: "file",
      path,
      detail:
        `A ${match.evidenceClass} value is interpolated through the imported Drizzle sql binding '${match.sqlBinding}'; source and parameter content were withheld.`,
    }],
    impact:
      "postgres-js can receive a JavaScript Date where an encoded timestamp string is required, causing a runtime parameter-type failure.",
    remediationConstraints: [
      "Only an authorized human or external coding agent may change target repository files.",
      "Preserve the query's intended timestamp semantics and timezone behavior.",
      "Codebase Doctor provides guidance only and never edits or executes the query.",
    ],
    remediation:
      "Have an authorized human or external coding agent use a typed Drizzle comparison such as lte(column, date), or supply a proven explicit encoder, then rerun the audit.",
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --json"
        : "codebase-doctor audit . --json",
      expected:
        "The finding fingerprint is absent and database/drizzle coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: RULE_ID,
      location,
      identity: `${match.evidenceClass}:${match.sqlBinding}`,
    }),
  };
}

function limitationForAnalysis(path: string, limitation: DrizzleAnalysisLimitation): string {
  const location = limitation.line === undefined
    ? path
    : `${path}:${limitation.line}:${limitation.column ?? 1}`;
  switch (limitation.code) {
    case "parse-failure":
      return `${path}: source syntax could not be parsed.`;
    case "analysis-budget-exceeded":
      return `${path}: bounded Drizzle AST analysis budget was exceeded.`;
    case "match-limit-exceeded":
      return `${path}: Drizzle Date match retention limit was reached; additional matches were withheld.`;
    case "unresolved-interpolation":
      return `${location}: raw Drizzle value interpolation could not be classified within the supported Date-flow boundary.`;
  }
}

function coverage(
  snapshot: ProjectSnapshot,
  status: AuditCoverage["status"],
  filesExamined: number,
  linesExamined: number,
  findingsRecognized: number,
  values: readonly string[],
): AuditCoverage {
  const bounded = boundLimitations(values);
  return {
    moduleId: DOCTOR_ID,
    status,
    scope: snapshot.auditScope.mode,
    filesExamined,
    statementsExamined: linesExamined,
    statementsRecognized: findingsRecognized,
    limitations: bounded.limitations,
    ...(bounded.groups.length === 0 ? {} : { limitationGroups: bounded.groups }),
    ...(bounded.summary.omitted === 0 ? {} : { limitationSummary: bounded.summary }),
  };
}

export function createDrizzleDoctor(options: DrizzleDoctorOptions = {}): Doctor {
  const maxFileBytes = positiveSafeInteger(
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    "maxFileBytes",
  );
  const maxTotalBytes = positiveSafeInteger(
    options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxFiles = positiveSafeInteger(
    options.maxFiles ?? DEFAULT_MAX_DRIZZLE_FILES,
    "maxFiles",
  );
  const maxFindings = positiveSafeInteger(
    options.maxFindings ?? DEFAULT_MAX_FINDINGS,
    "maxFindings",
  );
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const limitations: string[] = [];
      const cache = new Map<string, string>();
      const admittedPaths = new Set<string>();
      const adapterImportPaths: string[] = [];
      let totalBytes = 0;

      const candidates = discoveryFiles(snapshot);
      const admittedCandidates = candidates.slice(0, maxFiles);
      if (candidates.length > maxFiles) {
        limitations.push(
          `Drizzle source file limit of ${maxFiles} was reached; ${candidates.length - maxFiles} current supported file(s) were not discovered or analyzed.`,
        );
      }

      for (const file of admittedCandidates) {
        admittedPaths.add(file.path);
        if (file.size > maxFileBytes) {
          limitations.push(
            `${file.path}: file exceeds the ${maxFileBytes}-byte Drizzle audit size limit.`,
          );
          continue;
        }
        if (totalBytes + file.size > maxTotalBytes) {
          limitations.push(
            `${file.path}: total Drizzle audit content limit of ${maxTotalBytes} bytes was reached; remaining context and selected files were not examined.`,
          );
          break;
        }
        const absolutePath = safeAbsolutePath(snapshot.root, file.path);
        if (absolutePath === undefined) {
          limitations.push(`${file.path}: inventoried source path could not be safely read.`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(absolutePath);
        } catch {
          limitations.push(`${file.path}: unable to read selected source for Drizzle audit.`);
          continue;
        }
        if (bytes.byteLength > maxFileBytes) {
          limitations.push(
            `${file.path}: file exceeds the ${maxFileBytes}-byte Drizzle audit size limit.`,
          );
          continue;
        }
        if (totalBytes + bytes.byteLength > maxTotalBytes) {
          limitations.push(
            `${file.path}: total Drizzle audit content limit of ${maxTotalBytes} bytes was reached after inventory size changed; remaining context and selected files were not examined.`,
          );
          break;
        }
        totalBytes += bytes.byteLength;
        const source = Buffer.from(bytes).toString("utf8");
        cache.set(file.path, source);
        const adapter = analyzeDrizzlePostgresJsAdapterImport(file.path, source);
        if (adapter.status === "partial") {
          limitations.push(
            `${file.path}: source syntax could not be parsed for postgres-js adapter applicability discovery.`,
          );
        } else if (adapter.present) {
          adapterImportPaths.push(file.path);
        }
      }

      const selection = selectDrizzleAuditFiles(snapshot, {
        maxFiles,
        postgresJsImportPaths: adapterImportPaths,
      });
      limitations.push(...selection.limitations);

      const findings: Finding[] = [];
      let filesExamined = 0;
      let linesExamined = 0;
      let findingLimitReached = false;
      for (const file of selection.files) {
        if (findings.length >= maxFindings) {
          findingLimitReached = true;
          break;
        }
        if (!admittedPaths.has(file.path)) {
          limitations.push(
            `${file.path}: selected source was outside the combined ${maxFiles}-file Drizzle audit ceiling.`,
          );
          continue;
        }
        const source = cache.get(file.path);
        if (source === undefined) continue;
        const analysis = analyzeDrizzleRawSqlDates(file.path, source, {
          maxMatches: maxFindings - findings.length,
        });
        filesExamined += 1;
        linesExamined += lineCount(source);
        limitations.push(...analysis.limitations.map((entry) =>
          limitationForAnalysis(file.path, entry)
        ));
        const remaining = maxFindings - findings.length;
        const accepted = analysis.matches.slice(0, remaining);
        findings.push(...accepted.map((match) =>
          findingFor(file.path, match, snapshot.auditScope.mode === "changed")
        ));
        if (analysis.matches.length > remaining) {
          findingLimitReached = true;
          break;
        }
      }
      if (findingLimitReached) {
        limitations.push(
          `Drizzle audit finding limit of ${maxFindings} was reached; additional matches and remaining selected files were not reported.`,
        );
      }

      const substantiveLimitations = limitations.length > 0;
      if (snapshot.auditScope.mode === "changed" && selection.files.length > 0) {
        limitations.push(
          "Changed scope examined selected current changed files only; unchanged files were not independently re-audited.",
        );
      }
      const status: AuditCoverage["status"] = substantiveLimitations
        ? "partial"
        : selection.applicableProjectIds.length === 0
          ? "not-applicable"
          : snapshot.auditScope.mode === "changed" && selection.files.length === 0
            ? "not-selected"
            : "completed";

      return {
        status: "completed",
        findings: sortFindings(findings),
        coverage: [coverage(
          snapshot,
          status,
          filesExamined,
          linesExamined,
          findings.length,
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
