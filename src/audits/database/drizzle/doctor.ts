import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
  /**
   * A bounded reader must return at most `allowance + 1` bytes. The extra byte
   * is a size-growth sentinel and is never admitted to analysis.
   */
  readonly readFile?: (
    absolutePath: string,
    allowance: number,
  ) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
  readonly maxFindings?: number;
  readonly maxLimitations?: number;
}

const DEFAULT_MAX_LIMITATIONS = 100;
const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class SafeReadFailure extends Error {
  constructor(readonly reason: "unavailable" | "not-regular") {
    super("Bounded source read failed.");
  }
}

/**
 * Protects the final path component with O_NOFOLLOW, validates the opened
 * handle, and never reads beyond allowance plus one sentinel byte. This does
 * not claim openat2-style protection against hostile replacement of ancestor
 * directories.
 */
async function readBoundedRegularFile(
  absolutePath: string,
  allowance: number,
): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new SafeReadFailure("unavailable");
  }
  try {
    let metadata;
    try {
      metadata = await handle.stat();
    } catch {
      throw new SafeReadFailure("unavailable");
    }
    if (!metadata.isFile()) throw new SafeReadFailure("not-regular");

    const chunks: Buffer[] = [];
    let remaining = allowance + 1;
    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null));
      } catch {
        throw new SafeReadFailure("unavailable");
      }
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return Buffer.concat(chunks);
  } finally {
    try {
      await handle.close();
    } catch {
      // The read result remains bounded; close errors are never disclosed.
    }
  }
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

class ProjectOwnerIndex {
  readonly #byRoot = new Map<string, DetectedProject[]>();

  constructor(projects: readonly DetectedProject[]) {
    for (const project of projects) {
      const atRoot = this.#byRoot.get(project.root) ?? [];
      atRoot.push(project);
      this.#byRoot.set(project.root, atRoot);
    }
  }

  uniqueOwner(path: string): DetectedProject | "ambiguous" | undefined {
    let prefix = path;
    while (prefix.length > 0) {
      const exact = this.#byRoot.get(prefix);
      if (exact !== undefined) return exact.length === 1 ? exact[0] : "ambiguous";
      const separator = prefix.lastIndexOf("/");
      if (separator < 0) break;
      prefix = prefix.slice(0, separator);
    }
    const root = this.#byRoot.get(".");
    return root === undefined ? undefined : root.length === 1 ? root[0] : "ambiguous";
  }
}

class BoundedFileDiscovery {
  readonly #files: FileRecord[] = [];
  #candidateCount = 0;

  constructor(readonly maximum: number) {}

  admit(file: FileRecord): void {
    this.#candidateCount += 1;
    if (this.#files.length < this.maximum) {
      this.#files.push(file);
      this.#bubbleUp(this.#files.length - 1);
      return;
    }
    const latest = this.#files[0];
    if (latest === undefined || compareCodePoints(file.path, latest.path) >= 0) return;
    this.#files[0] = file;
    this.#sinkDown(0);
  }

  orderedFiles(): readonly FileRecord[] {
    return [...this.#files].sort((left, right) => compareCodePoints(left.path, right.path));
  }

  omittedCount(): number {
    return this.#candidateCount - this.#files.length;
  }

  #bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCodePoints(this.#files[parent]!.path, this.#files[index]!.path) >= 0) return;
      [this.#files[parent], this.#files[index]] = [this.#files[index]!, this.#files[parent]!];
      index = parent;
    }
  }

  #sinkDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let latest = index;
      if (left < this.#files.length &&
          compareCodePoints(this.#files[left]!.path, this.#files[latest]!.path) > 0) latest = left;
      if (right < this.#files.length &&
          compareCodePoints(this.#files[right]!.path, this.#files[latest]!.path) > 0) latest = right;
      if (latest === index) return;
      [this.#files[index], this.#files[latest]] = [this.#files[latest]!, this.#files[index]!];
      index = latest;
    }
  }
}

class BoundedLimitationCollector {
  readonly #values: string[] = [];
  #occurrences = 0;

  constructor(readonly maximum: number) {}

  get occurrenceCount(): number {
    return this.#occurrences;
  }

  add(value: string): void {
    this.#occurrences += 1;
    if (this.#values.length < this.maximum) {
      this.#values.push(value);
      this.#bubbleUp(this.#values.length - 1);
      return;
    }
    const latest = this.#values[0];
    if (latest === undefined || compareCodePoints(value, latest) >= 0) return;
    this.#values[0] = value;
    this.#sinkDown(0);
  }

  addAll(values: readonly string[]): void {
    for (const value of values) this.add(value);
  }

  output(): {
    limitations: readonly string[];
    summary?: { total: number; emitted: number; omitted: number };
  } {
    const limitations = [...new Set(this.#values.sort(compareCodePoints))];
    const emitted = limitations.length;
    const omitted = this.#occurrences - emitted;
    return {
      limitations,
      ...(omitted === 0 ? {} : {
        summary: { total: this.#occurrences, emitted, omitted },
      }),
    };
  }

  #bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCodePoints(this.#values[parent]!, this.#values[index]!) >= 0) return;
      [this.#values[parent], this.#values[index]] = [this.#values[index]!, this.#values[parent]!];
      index = parent;
    }
  }

  #sinkDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let latest = index;
      if (left < this.#values.length &&
          compareCodePoints(this.#values[left]!, this.#values[latest]!) > 0) latest = left;
      if (right < this.#values.length &&
          compareCodePoints(this.#values[right]!, this.#values[latest]!) > 0) latest = right;
      if (latest === index) return;
      [this.#values[index], this.#values[latest]] = [this.#values[latest]!, this.#values[index]!];
      index = latest;
    }
  }
}

function discoverFiles(
  snapshot: ProjectSnapshot,
  maximum: number,
  limitations: BoundedLimitationCollector,
): BoundedFileDiscovery {
  const affected = new Set(snapshot.auditScope.affectedProjectIds);
  const owners = new ProjectOwnerIndex(snapshot.projects);
  const selected = new BoundedFileDiscovery(maximum);
  for (const file of snapshot.files) {
    if (!supportedRegularFile(file)) continue;
    const owner = owners.uniqueOwner(file.path);
    if (owner === "ambiguous") {
      limitations.add(`${file.path}: source ownership is ambiguous; adapter applicability discovery was withheld.`);
      continue;
    }
    if (owner === undefined ||
        (snapshot.auditScope.mode === "changed" && !affected.has(owner.id))) continue;
    selected.admit(file);
  }
  return selected;
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
      identity: match.evidenceClass,
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
  collector: BoundedLimitationCollector,
): AuditCoverage {
  const bounded = collector.output();
  return {
    moduleId: DOCTOR_ID,
    status,
    scope: snapshot.auditScope.mode,
    filesExamined,
    statementsExamined: linesExamined,
    statementsRecognized: findingsRecognized,
    limitations: bounded.limitations,
    ...(bounded.summary === undefined ? {} : { limitationSummary: bounded.summary }),
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
  const maxLimitations = positiveSafeInteger(
    options.maxLimitations ?? DEFAULT_MAX_LIMITATIONS,
    "maxLimitations",
  );
  const readSelectedFile = options.readFile ?? readBoundedRegularFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const limitations = new BoundedLimitationCollector(maxLimitations);
      const cache = new Map<string, string>();
      const admittedPaths = new Set<string>();
      const adapterImportPaths: string[] = [];
      let totalBytes = 0;

      const discovery = discoverFiles(snapshot, maxFiles, limitations);
      const omittedCandidates = discovery.omittedCount();
      if (omittedCandidates > 0) {
        limitations.add(
          `Drizzle source file limit of ${maxFiles} was reached; ${omittedCandidates} current supported file(s) were not discovered or analyzed.`,
        );
      }

      for (const file of discovery.orderedFiles()) {
        admittedPaths.add(file.path);
        if (file.size > maxFileBytes) {
          limitations.add(
            `${file.path}: file exceeds the ${maxFileBytes}-byte Drizzle audit size limit.`,
          );
          continue;
        }
        if (totalBytes + file.size > maxTotalBytes) {
          limitations.add(
            `${file.path}: total Drizzle audit content limit of ${maxTotalBytes} bytes was reached; remaining context and selected files were not examined.`,
          );
          break;
        }
        const absolutePath = safeAbsolutePath(snapshot.root, file.path);
        if (absolutePath === undefined) {
          limitations.add(`${file.path}: inventoried source path could not be safely read.`);
          continue;
        }
        const remainingTotalBytes = maxTotalBytes - totalBytes;
        const allowance = Math.min(maxFileBytes, remainingTotalBytes);
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(absolutePath, allowance);
        } catch (error) {
          limitations.add(error instanceof SafeReadFailure && error.reason === "not-regular"
            ? `${file.path}: inventoried source is no longer a regular file.`
            : `${file.path}: unable to safely read the final source path for Drizzle audit.`);
          continue;
        }
        if (bytes.byteLength > allowance + 1) {
          limitations.add(
            `${file.path}: bounded source reader exceeded its redacted byte contract; content was rejected.`,
          );
          continue;
        }
        totalBytes += bytes.byteLength;
        if (bytes.byteLength > allowance) {
          if (allowance === maxFileBytes) {
            limitations.add(
              `${file.path}: file exceeds the ${maxFileBytes}-byte Drizzle audit size limit.`,
            );
          } else {
            limitations.add(
              `${file.path}: total Drizzle audit content limit of ${maxTotalBytes} bytes was reached while bounded-reading source.`,
            );
          }
          continue;
        }
        if (bytes.byteLength !== file.size) {
          limitations.add(
            `${file.path}: source size changed after inventory; content was withheld from analysis.`,
          );
          continue;
        }
        if (totalBytes > maxTotalBytes) {
          limitations.add(
            `${file.path}: total Drizzle audit content limit of ${maxTotalBytes} bytes was exceeded by a bounded growth sentinel.`,
          );
          break;
        }
        let source: string;
        try {
          source = UTF8_DECODER.decode(bytes);
        } catch {
          limitations.add(`${file.path}: selected source is not valid UTF-8.`);
          continue;
        }
        cache.set(file.path, source);
        const adapter = analyzeDrizzlePostgresJsAdapterImport(file.path, source);
        if (adapter.status === "partial") {
          limitations.add(
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
      limitations.addAll(selection.limitations);

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
          limitations.add(
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
        for (const entry of analysis.limitations) {
          limitations.add(limitationForAnalysis(file.path, entry));
        }
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
        limitations.add(
          `Drizzle audit finding limit of ${maxFindings} was reached; additional matches and remaining selected files were not reported.`,
        );
      }

      const substantiveLimitations = limitations.occurrenceCount > 0;
      if (snapshot.auditScope.mode === "changed" && selection.files.length > 0) {
        limitations.add(
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
