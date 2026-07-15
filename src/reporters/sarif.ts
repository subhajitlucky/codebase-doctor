import type { Finding, Severity } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";

type SarifLevel = "error" | "warning" | "note";

function level(severity: Severity): SarifLevel {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function baselineState(result: ScanResult, fingerprint: string): "new" | "unchanged" | undefined {
  if (result.comparison?.new.includes(fingerprint) === true) return "new";
  if (result.comparison?.unchanged.includes(fingerprint) === true) return "unchanged";
  return undefined;
}

function location(finding: Finding): object[] | undefined {
  if (finding.location === undefined) return undefined;
  const { path, line, column } = finding.location;
  const region = line === undefined && column === undefined
    ? undefined
    : {
        startLine: line ?? 1,
        ...(column === undefined ? {} : { startColumn: column }),
      };
  return [{
    physicalLocation: {
      artifactLocation: { uri: path.replaceAll("\\", "/") },
      ...(region === undefined ? {} : { region }),
    },
  }];
}

function rule(finding: Finding): object {
  return {
    id: finding.ruleId,
    shortDescription: { text: finding.title },
    fullDescription: { text: finding.message },
    defaultConfiguration: { level: level(finding.severity) },
    ...(finding.remediation === undefined
      ? {}
      : { help: { text: finding.remediation } }),
    properties: {
      category: finding.category,
      doctorId: finding.doctorId,
    },
  };
}

function sarifResult(result: ScanResult, finding: Finding): object {
  const state = baselineState(result, finding.fingerprint);
  const locations = location(finding);
  return {
    ruleId: finding.ruleId,
    level: level(finding.severity),
    message: { text: `${finding.title}: ${finding.message}` },
    partialFingerprints: {
      codebaseDoctorFingerprint: finding.fingerprint,
    },
    ...(state === undefined ? {} : { baselineState: state }),
    ...(locations === undefined ? {} : { locations }),
    properties: {
      category: finding.category,
      confidence: finding.confidence,
      doctorId: finding.doctorId,
      evidence: finding.evidence,
      ...(finding.remediation === undefined ? {} : { remediation: finding.remediation }),
    },
  };
}

export function renderSarifReport(result: ScanResult): string {
  const rules = new Map<string, Finding>();
  for (const finding of result.findings) {
    if (!rules.has(finding.ruleId)) rules.set(finding.ruleId, finding);
  }
  const report = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Codebase Doctor",
          semanticVersion: result.tool.version,
          informationUri: "https://github.com/subhajitlucky/codebase-doctor",
          rules: [...rules.values()]
            .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
            .map(rule),
        },
      },
      results: result.findings.map((finding) => sarifResult(result, finding)),
    }],
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
