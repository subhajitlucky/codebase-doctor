import { readFile } from "node:fs/promises";
import { SEVERITIES, type Finding, type Severity } from "./findings.js";
import { summarizeFindings, type FindingSummary } from "./summary.js";
import type { ScanResult } from "./normalize.js";

export interface BaselineReport {
  schemaVersion: "1";
  findings: readonly Finding[];
}

export interface FindingComparison {
  new: readonly string[];
  unchanged: readonly string[];
  resolved: readonly string[];
  newSummary: FindingSummary;
}

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baselineFinding(value: unknown, index: number): Finding {
  if (!isObject(value) || typeof value.fingerprint !== "string" || value.fingerprint.length === 0) {
    throw new BaselineError(`Baseline finding ${index} must have a non-empty fingerprint.`);
  }
  if (typeof value.severity !== "string" || !SEVERITIES.includes(value.severity as Severity)) {
    throw new BaselineError(`Baseline finding ${index} has an invalid severity.`);
  }
  return value as unknown as Finding;
}

export async function loadBaseline(path: string): Promise<BaselineReport> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new BaselineError(
      `Could not read baseline ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new BaselineError(`Baseline ${path} must contain valid JSON.`);
  }
  if (!isObject(value) || value.schemaVersion !== "1" ||
      !isObject(value.tool) || value.tool.name !== "codebase-doctor" ||
      !Array.isArray(value.findings)) {
    throw new BaselineError(`Baseline ${path} is not a Codebase Doctor schema-1 report.`);
  }
  return {
    schemaVersion: "1",
    findings: value.findings.map(baselineFinding),
  };
}

export function compareFindingBaseline(
  current: readonly Finding[],
  baseline: readonly Finding[],
): FindingComparison {
  const currentFingerprints = new Set(current.map(({ fingerprint }) => fingerprint));
  const baselineFingerprints = new Set(baseline.map(({ fingerprint }) => fingerprint));
  const newFindings = current.filter(({ fingerprint }) => !baselineFingerprints.has(fingerprint));
  return {
    new: newFindings.map(({ fingerprint }) => fingerprint).sort(),
    unchanged: [...currentFingerprints].filter((fingerprint) =>
      baselineFingerprints.has(fingerprint),
    ).sort(),
    resolved: [...baselineFingerprints].filter((fingerprint) =>
      !currentFingerprints.has(fingerprint),
    ).sort(),
    newSummary: summarizeFindings(newFindings),
  };
}

export function withBaselineComparison(
  result: ScanResult,
  baseline: readonly Finding[],
): ScanResult {
  return { ...result, comparison: compareFindingBaseline(result.findings, baseline) };
}
