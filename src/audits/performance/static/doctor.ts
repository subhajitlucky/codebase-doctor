import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";
import { selectChangedCandidates } from "../../../scope/changed-files.js";
import type { ChangedPath } from "../../../scope/types.js";
import type { FileRecord, ProjectSnapshot } from "../../../workspace/types.js";

const DOCTOR_ID = "performance/static";
const DEFAULT_LARGE_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FINDINGS = 100;

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "go.sum",
]);

const BINARY_ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".pdf",
  ".zip",
  ".gz",
]);

// Directory patterns are limited to what the inventory can yield: dist/,
// build/, .next/, and node_modules/ never reach any doctor because the
// workspace inventory skips them at every depth. An ignored directory that is
// force-added to git is therefore outside this module's reach.
const BUILD_OUTPUT_PATTERNS = [
  /\.map$/iu,
  /\.tsbuildinfo$/iu,
  /\.min\.js$/iu,
  /\.bundle\.js$/iu,
  /(?:^|\/)coverage\//u,
  /(?:^|\/)out\//u,
  /(?:^|\/)lcov\.info$/u,
];

export interface PerformanceDoctorOptions {
  readonly largeFileBytes?: number;
  readonly maxFindings?: number;
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function extension(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function isBuildOutput(path: string): boolean {
  return BUILD_OUTPUT_PATTERNS.some((pattern) => pattern.test(path));
}

function findingFor(
  ruleId: string,
  severity: Finding["severity"],
  path: string,
  title: string,
  message: string,
  detail: string,
  identity: string,
  impact: string,
  remediation: string,
  changed: boolean,
): Finding {
  const location = { path };
  return {
    ruleId: `${DOCTOR_ID}/${ruleId}`,
    doctorId: DOCTOR_ID,
    severity,
    confidence: "high",
    category: "performance",
    title,
    message,
    location,
    evidence: [{ type: "file", path, detail }],
    impact,
    remediationConstraints: [
      "Confirm the file is tracked content; ignored local build output is normal and is not reported.",
    ],
    remediation,
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected: "The finding fingerprint is absent and performance/static coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${ruleId}`,
      location,
      identity,
    }),
  };
}

/**
 * Select the inventoried files to examine, mirroring the secrets audit: full
 * mode keeps only repository-shareable paths (tracked or unignored) so
 * ignored local build output is never reported; changed mode examines changed
 * paths present in the inventory.
 */
function selectFiles(
  snapshot: ProjectSnapshot,
): { paths: readonly string[]; limitations: string[]; scopeNote: boolean } {
  const sizes = new Map(
    snapshot.files
      .filter((file) => file.kind === "file")
      .map((file) => [file.path, file.size] as const),
  );
  if (snapshot.auditScope.mode === "changed") {
    const selection = selectChangedCandidates(
      snapshot.auditScope.changes,
      snapshot.files,
      (path) => isBuildOutput(path) || (sizes.get(path) ?? 0) > 0,
      "performance",
    );
    return {
      paths: [...selection.candidates],
      limitations: [...selection.limitations],
      scopeNote: selection.candidates.length > 0,
    };
  }
  if (snapshot.repositoryFiles?.availability === "available") {
    const shareable = new Set(snapshot.repositoryFiles.paths);
    return {
      paths: [...sizes.keys()].filter((path) => shareable.has(path)).sort(),
      limitations: [...new Set(snapshot.repositoryFiles.limitations)].sort(),
      scopeNote: false,
    };
  }
  return {
    paths: [...sizes.keys()].sort(),
    limitations: [
      ...(snapshot.repositoryFiles?.limitations.length
        ? snapshot.repositoryFiles.limitations
        : ["Git shareable-file selection was unavailable; ignored local build output may be reported."]),
    ],
    scopeNote: false,
  };
}

export function createPerformanceDoctor(options: PerformanceDoctorOptions = {}): Doctor {
  const largeFileBytes = options.largeFileBytes ?? DEFAULT_LARGE_FILE_BYTES;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const changed = snapshot.auditScope.mode === "changed";
      const scope = changed ? "changed" : "full";
      const selection = selectFiles(snapshot);
      const candidates = selection.paths;
      const limitations: string[] = [...selection.limitations];

      if (candidates.length === 0) {
        const emptyLimitations = changed && snapshot.files.length > 0
          ? [
            ...limitations,
            "No changed performance files were selected; unchanged files were not independently re-audited.",
          ]
          : limitations;
        return {
          status: "completed",
          findings: [],
          coverage: [{
            moduleId: DOCTOR_ID,
            status: changed && snapshot.files.length > 0 ? "not-selected" : "not-applicable",
            scope,
            filesExamined: 0,
            statementsExamined: 0,
            statementsRecognized: 0,
            limitations: emptyLimitations,
          }],
          durationMs: Date.now() - startedAt,
        };
      }
      if (selection.scopeNote) {
        limitations.push("Changed scope examined selected current changed files only; unchanged files were not independently re-audited.");
      }

      const findings: Finding[] = [];
      let filesExamined = 0;
      const sizes = new Map(
        snapshot.files
          .filter((file) => file.kind === "file")
          .map((file) => [file.path, file.size] as const),
      );
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(
            `Performance audit finding limit of ${maxFindings} was reached; remaining files were not reported.`,
          );
          break;
        }
        const size = sizes.get(path);
        if (size === undefined) continue;
        filesExamined += 1;
        const base = basename(path);
        if (isBuildOutput(path)) {
          findings.push(findingFor(
            "committed-build-artifact",
            "low",
            path,
            "Committed build output slows clones and scans",
            `The inventoried path ${path} looks like generated build output (${size} bytes).`,
            `build-output pattern match; ${size} bytes inventoried`,
            "build-artifact",
            "Generated output bloats clones and scans, and goes stale when the source changes without a rebuild.",
            "Remove the generated file from tracked content and ignore it (for example in .gitignore); regenerate it during builds instead.",
            changed,
          ));
          continue;
        }
        if (size > largeFileBytes && !LOCKFILE_BASENAMES.has(base) && !BINARY_ASSET_EXTENSIONS.has(extension(path))) {
          findings.push(findingFor(
            "large-file",
            "low",
            path,
            "Large source file slows clones, scans, and reviews",
            `The inventoried file ${path} is ${size} bytes, above the ${largeFileBytes}-byte threshold.`,
            `${size} bytes inventoried; threshold ${largeFileBytes} bytes`,
            `large:${size}`,
            "Large files slow down clones, scans, editor tooling, and code review.",
            "Split the file, move fixtures or generated content out of tracked sources, or store large assets in Git LFS.",
            changed,
          ));
        }
      }

      const coverage: AuditCoverage = {
        moduleId: DOCTOR_ID,
        status: limitations.length > 0 ? "partial" : "completed",
        scope,
        filesExamined,
        statementsExamined: filesExamined,
        statementsRecognized: Math.min(findings.length, maxFindings),
        limitations: [...new Set(limitations)].sort(),
      };
      return {
        status: "completed",
        findings: sortFindings(findings).slice(0, maxFindings),
        coverage: [coverage],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
