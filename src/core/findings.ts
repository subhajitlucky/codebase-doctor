import { createHash } from "node:crypto";
import { posix } from "node:path";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = "low" | "medium" | "high";

export type Evidence =
  | { type: "file"; path: string; detail: string }
  | { type: "manifest"; path: string; detail: string }
  | { type: "command"; command: string; exitCode: number; output?: string }
  | {
      type: "database";
      schema: string;
      table?: string;
      policy?: string;
      detail: string;
    }
  | { type: "observation"; detail: string };

export interface Finding {
  ruleId: string;
  doctorId: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  title: string;
  message: string;
  location?: { path: string; line?: number; column?: number };
  evidence: readonly Evidence[];
  remediation?: string;
  fingerprint: string;
}

export interface FingerprintInput {
  doctorId: string;
  ruleId: string;
  location?: { path: string; line?: number; column?: number };
  identity: string;
}

function normalizeFindingPath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/"));
}

export function createFingerprint(input: FingerprintInput): string {
  const location = input.location === undefined
    ? null
    : [
        normalizeFindingPath(input.location.path),
        input.location.line ?? null,
        input.location.column ?? null,
      ];
  const canonicalIdentity = JSON.stringify([
    input.doctorId,
    input.ruleId,
    location,
    input.identity,
  ]);

  return createHash("sha256").update(canonicalIdentity).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareFindings(left: Finding, right: Finding): number {
  const severityDifference =
    SEVERITIES.indexOf(right.severity) - SEVERITIES.indexOf(left.severity);
  if (severityDifference !== 0) return severityDifference;

  const doctorDifference = compareText(left.doctorId, right.doctorId);
  if (doctorDifference !== 0) return doctorDifference;

  const pathDifference = compareText(
    normalizeFindingPath(left.location?.path ?? ""),
    normalizeFindingPath(right.location?.path ?? ""),
  );
  if (pathDifference !== 0) return pathDifference;

  const ruleDifference = compareText(left.ruleId, right.ruleId);
  if (ruleDifference !== 0) return ruleDifference;

  return compareText(left.fingerprint, right.fingerprint);
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}
