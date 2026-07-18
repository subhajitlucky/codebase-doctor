import type { AuditCoverage, Doctor } from "../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../core/findings.js";
import { impactedSourcePaths } from "../source-graph/impact.js";
import type { SourceGraphEdge, SourceImpact } from "../source-graph/types.js";
import {
  DEFAULT_MAX_SOURCE_INTEGRITY_FINDINGS,
  MISSING_IMPORT_TARGET_RULE_ID,
  SOURCE_INTEGRITY_DOCTOR_ID,
  type SourceIntegrityDoctorOptions,
} from "./types.js";

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function compareEdges(left: SourceGraphEdge, right: SourceGraphEdge): number {
  return left.importerPath.localeCompare(right.importerPath) ||
    left.targetPath.localeCompare(right.targetPath) ||
    left.kind.localeCompare(right.kind) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0);
}

function selectedImporterPaths(impact: SourceImpact): ReadonlySet<string> | undefined {
  if (impact.mode === "full") return undefined;
  return new Set([
    ...impact.changedSourcePaths,
    ...impactedSourcePaths(impact),
  ]);
}

function isProvablyMissing(edge: SourceGraphEdge): edge is SourceGraphEdge & {
  readonly targetExists: false;
  readonly missingTargetProof: NonNullable<SourceGraphEdge["missingTargetProof"]>;
} {
  return edge.targetExists === false && edge.missingTargetProof !== undefined;
}

function findingFor(edge: SourceGraphEdge & {
  readonly targetExists: false;
  readonly missingTargetProof: NonNullable<SourceGraphEdge["missingTargetProof"]>;
}, mode: SourceImpact["mode"]): Finding {
  const location = {
    path: edge.importerPath,
    ...(edge.line === undefined ? {} : { line: edge.line }),
    ...(edge.column === undefined ? {} : { column: edge.column }),
  };
  return {
    ruleId: MISSING_IMPORT_TARGET_RULE_ID,
    doctorId: SOURCE_INTEGRITY_DOCTOR_ID,
    severity: "high",
    confidence: "high",
    category: "correctness",
    title: "Internal import target is missing",
    message:
      "A statically resolved internal source reference points to a target absent from the current bounded repository inventory.",
    location,
    evidence: [{
      type: "file",
      path: edge.importerPath,
      detail:
        `Expected internal target ${edge.targetPath} (${edge.kind}; proof: ${edge.missingTargetProof}), but it is absent from the bounded repository inventory.`,
    }],
    impact:
      "The affected import, type check, build, or runtime module load can fail when this path is evaluated.",
    remediationConstraints: [
      "Only an authorized human or external agent may change target repository files.",
      "Preserve the intended module boundary instead of inventing whether this should be a local file or package entry.",
      "Do not create, rename, or rewrite files without independently confirming the intended target.",
    ],
    remediation:
      "Confirm the intended module path, then have an authorized human or external agent restore the target or correct the reference. Codebase Doctor does not modify files.",
    verification: {
      command: mode === "changed"
        ? "codebase-doctor scan --changed --format json"
        : "codebase-doctor scan --format json",
      expected:
        "This finding fingerprint is absent and repository/source-integrity coverage is completed.",
    },
    fingerprint: createFingerprint({
      doctorId: SOURCE_INTEGRITY_DOCTOR_ID,
      ruleId: MISSING_IMPORT_TARGET_RULE_ID,
      location,
      identity: JSON.stringify([
        edge.targetPath,
        edge.kind,
        edge.missingTargetProof,
      ]),
    }),
  };
}

export function createSourceIntegrityDoctor(
  options: SourceIntegrityDoctorOptions = {},
): Doctor {
  const maxFindings = positiveSafeInteger(
    options.maxFindings ?? DEFAULT_MAX_SOURCE_INTEGRITY_FINDINGS,
    "maxFindings",
  );

  return {
    id: SOURCE_INTEGRITY_DOCTOR_ID,
    version: "0.1.0",
    capabilities: [],
    supports: (snapshot) =>
      snapshot.sourceGraph !== undefined && snapshot.sourceImpact !== undefined,
    diagnose: async ({ snapshot }) => {
      const graph = snapshot.sourceGraph;
      const impact = snapshot.sourceImpact;
      if (graph === undefined || impact === undefined) {
        throw new Error("Precomputed source graph impact is unavailable.");
      }

      const selectedImporters = selectedImporterPaths(impact);
      const selectedEdges = graph.edges
        .filter((edge) =>
          selectedImporters === undefined || selectedImporters.has(edge.importerPath)
        )
        .sort(compareEdges);
      const candidates = selectedEdges.filter(isProvablyMissing);
      const findings = sortFindings(
        candidates.slice(0, maxFindings).map((edge) => findingFor(edge, impact.mode)),
      );
      const limitations = new Set(impact.limitations);
      const wasLimited = candidates.length > maxFindings;
      if (wasLimited) {
        limitations.add(
          `Source integrity findings were limited to ${maxFindings} of ${candidates.length} provably missing targets.`,
        );
      }
      const specialStatus = impact.status === "not-applicable" ||
          impact.status === "not-selected"
        ? impact.status
        : undefined;
      const coverageStatus = specialStatus ??
        (impact.status === "partial" || wasLimited ? "partial" : "completed");
      const coverage: AuditCoverage = {
        moduleId: SOURCE_INTEGRITY_DOCTOR_ID,
        status: coverageStatus,
        scope: impact.mode,
        filesExamined: impact.mode === "full"
          ? graph.filesExamined
          : new Set(selectedEdges.map(({ importerPath }) => importerPath)).size,
        statementsExamined: selectedEdges.length,
        statementsRecognized: findings.length,
        limitations: [...limitations].sort(),
      };

      return {
        status: "completed",
        findings,
        durationMs: 0,
        coverage: [coverage],
      };
    },
  };
}

export const sourceIntegrityDoctor = createSourceIntegrityDoctor();
