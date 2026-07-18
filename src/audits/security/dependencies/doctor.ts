import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import {
  createFingerprint,
  sortFindings,
  type Evidence,
  type Finding,
} from "../../../core/findings.js";
import { analyzeDependencyTarget, type InternalPackage } from "./analyzer.js";
import { parseNpmLock, type NpmLockParseResult } from "./parser.js";
import { selectDependencyAuditTargets } from "./selection.js";
import { safeNpmPackageName } from "./source.js";
import type { DependencyFindingFamily, DependencyMatch } from "./types.js";

const DOCTOR_ID = "security/dependencies";
const DEFAULT_MAX_FILE_BYTES = 20_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 100_000_000;
const DEFAULT_MAX_FINDINGS_PER_TARGET = 100;
const DEFAULT_MAX_FINDINGS = 1_000;

export interface DependenciesDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindingsPerTarget?: number;
  readonly maxFindings?: number;
}

const TITLE_BY_FAMILY: Record<DependencyFindingFamily, string> = {
  "missing-lockfile": "External dependency graph has no governing lockfile",
  "manifest-lock-drift": "Package manifest and npm lockfile disagree",
  "insecure-source": "Dependency uses an insecure source transport",
  "mutable-git-source": "Git dependency is not locked to an immutable commit",
  "missing-integrity": "Resolved npm tarball lacks valid integrity evidence",
  "workspace-registry-resolution": "Internal workspace name resolves outside its member",
  "competing-npm-lockfiles": "Competing npm lockfiles can diverge",
};

const IMPACT_BY_FAMILY: Record<DependencyFindingFamily, string> = {
  "missing-lockfile": "Unpinned resolution can produce a different dependency graph across installs.",
  "manifest-lock-drift": "Installers may use dependency metadata that does not represent the reviewed manifest.",
  "insecure-source": "An unencrypted transport can permit dependency content or source references to be altered in transit.",
  "mutable-git-source": "A mutable Git reference can resolve to different code without a manifest change.",
  "missing-integrity": "The lockfile does not provide valid local integrity evidence for the resolved tarball.",
  "workspace-registry-resolution": "An internal package name resolving externally can install unintended registry content.",
  "competing-npm-lockfiles": "Different npm lock authorities can silently describe different install graphs.",
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function evidenceFor(match: DependencyMatch): Evidence {
  const detail = [
    match.packageName === undefined ? "Dependency metadata" : `Dependency ${match.packageName}`,
    match.section === undefined ? undefined : `section ${match.section}`,
    match.sourceClass === undefined ? undefined : `source class ${match.sourceClass}`,
  ].filter((part): part is string => part !== undefined).join("; ");
  return match.path.endsWith("package.json")
    ? { type: "manifest", path: match.path, detail: `${detail}. Raw source values were withheld.` }
    : { type: "file", path: match.path, detail: `${detail}. Raw source values were withheld.` };
}

function findingFor(match: DependencyMatch, changed: boolean): Finding {
  const ruleId = `${DOCTOR_ID}/${match.family}`;
  const location = { path: match.path };
  return {
    ruleId,
    doctorId: DOCTOR_ID,
    severity: match.severity,
    confidence: match.confidence,
    category: "security",
    title: TITLE_BY_FAMILY[match.family],
    message: "Repository dependency metadata matched a high-confidence offline supply-chain rule. Raw source values were withheld.",
    location,
    evidence: [evidenceFor(match)],
    impact: IMPACT_BY_FAMILY[match.family],
    remediationConstraints: [
      "Preserve the intended package identities and supported runtime behavior.",
      "Use the repository's authorized package-manager workflow outside Codebase Doctor.",
      "Do not expose credentials while changing dependency source metadata.",
    ],
    remediation: "Have an authorized human or external coding agent correct and review the dependency metadata, then rerun the same audit scope.",
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected: "The finding fingerprint is absent and security/dependencies coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId,
      location,
      identity: [
        match.packageName ?? "",
        match.section ?? "",
        match.sourceClass ?? "",
      ].join(":"),
    }),
  };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  statementsExamined: number,
  statementsRecognized: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined,
    statementsRecognized,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createDependenciesDoctor(options: DependenciesDoctorOptions = {}): Doctor {
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    "Dependency audit file size limit",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "Dependency audit total content limit",
  );
  const maxFindingsPerTarget = positiveInteger(
    options.maxFindingsPerTarget,
    DEFAULT_MAX_FINDINGS_PER_TARGET,
    "Dependency audit per-target finding limit",
  );
  const maxFindings = positiveInteger(
    options.maxFindings,
    DEFAULT_MAX_FINDINGS,
    "Dependency audit finding limit",
  );
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const selection = selectDependencyAuditTargets(snapshot);
      const findings: Finding[] = [];
      const coverageRecords: AuditCoverage[] = [];
      const internalPackages: InternalPackage[] = snapshot.projects.flatMap((project) => {
        const name = project.packageName === undefined
          ? undefined
          : safeNpmPackageName(project.packageName);
        return name === undefined ? [] : [{ name, root: project.root }];
      });
      let totalBytes = 0;

      for (const unsupported of selection.unsupportedScopes) {
        coverageRecords.push(coverage(
          "unsupported",
          `${selection.scope}:${unsupported.projectId}`,
          0,
          0,
          0,
          [`${unsupported.projectId}: ${unsupported.ecosystem} dependency metadata is not supported.`],
        ));
      }
      for (const entry of selection.notApplicableScopes) {
        coverageRecords.push(coverage(
          "not-applicable",
          `${selection.scope}:${entry.projectId}`,
          0,
          0,
          0,
          [],
        ));
      }
      if (
        selection.scope === "changed" &&
        selection.targets.length === 0 &&
        selection.unsupportedScopes.length === 0 &&
        selection.notApplicableScopes.length === 0
      ) {
        coverageRecords.push(coverage(
          "not-selected",
          "changed",
          0,
          0,
          0,
          ["No affected dependency project was selected."],
        ));
      }

      for (const target of selection.targets) {
        const targetLimitations = [...selection.limitations, ...target.limitations];
        let parsedLock: NpmLockParseResult | undefined;
        let lockExamined = 0;
        let statementsExamined = 0;
        const scope = `${selection.scope}:${target.lockRoot}`;

        if (findings.length >= maxFindings) {
          targetLimitations.push(
            `Dependency audit finding limit of ${maxFindings} was reached; additional matches and remaining lock roots were not reported.`,
          );
          coverageRecords.push(coverage(
            "partial",
            scope,
            target.coveredProjects.length,
            0,
            0,
            targetLimitations,
          ));
          continue;
        }

        if (target.lockfile !== undefined) {
          const path = target.lockfile.path;
          if (target.lockfile.size > maxFileBytes) {
            targetLimitations.push(
              `${path}: file exceeds the ${maxFileBytes}-byte dependency audit size limit.`,
            );
          } else if (totalBytes + target.lockfile.size > maxTotalBytes) {
            targetLimitations.push(
              `${path}: total dependency audit content limit of ${maxTotalBytes} bytes was reached; remaining lockfiles were not examined.`,
            );
          } else {
            let bytes: Uint8Array | undefined;
            try {
              bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
            } catch {
              targetLimitations.push(`${path}: unable to read selected dependency metadata.`);
            }
            if (bytes !== undefined) {
              if (bytes.byteLength > maxFileBytes) {
                targetLimitations.push(
                  `${path}: file exceeds the ${maxFileBytes}-byte dependency audit size limit.`,
                );
              } else if (totalBytes + bytes.byteLength > maxTotalBytes) {
                targetLimitations.push(
                  `${path}: total dependency audit content limit of ${maxTotalBytes} bytes was reached; remaining lockfiles were not examined.`,
                );
              } else {
                totalBytes += bytes.byteLength;
                lockExamined = 1;
                parsedLock = parseNpmLock(Buffer.from(bytes).toString("utf8"));
                if (parsedLock.status === "supported") {
                  statementsExamined = parsedLock.graph.entries.length;
                }
              }
            }
          }
        }

        const canAnalyze = target.authority === "none" || parsedLock !== undefined;
        const analysis = canAnalyze
          ? analyzeDependencyTarget({
              target,
              manifests: snapshot.manifests,
              ...(parsedLock === undefined ? {} : { lock: parsedLock }),
              internalPackages,
            })
          : { matches: [], limitations: [] };
        targetLimitations.push(...analysis.limitations);

        const targetMatches = analysis.matches.slice(0, maxFindingsPerTarget);
        if (analysis.matches.length > maxFindingsPerTarget) {
          targetLimitations.push(
            `${target.lockfile?.path ?? target.lockRoot}: dependency finding limit of ${maxFindingsPerTarget} was reached; additional matches were withheld.`,
          );
        }
        const remaining = maxFindings - findings.length;
        const emittedMatches = targetMatches.slice(0, remaining);
        if (targetMatches.length > remaining) {
          targetLimitations.push(
            `Dependency audit finding limit of ${maxFindings} was reached; additional matches and remaining lock roots were not reported.`,
          );
        }
        findings.push(...emittedMatches.map((match) =>
          findingFor(match, snapshot.auditScope.mode === "changed")
        ));
        coverageRecords.push(coverage(
          targetLimitations.length > 0 ? "partial" : "completed",
          scope,
          target.coveredProjects.length + lockExamined,
          statementsExamined,
          emittedMatches.length,
          targetLimitations,
        ));
      }

      if (coverageRecords.length === 0) {
        coverageRecords.push(coverage(
          "not-applicable",
          selection.scope,
          0,
          0,
          0,
          selection.limitations,
        ));
      }

      return {
        status: "completed",
        findings: sortFindings(findings),
        coverage: coverageRecords.sort((left, right) => left.scope.localeCompare(right.scope)),
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
