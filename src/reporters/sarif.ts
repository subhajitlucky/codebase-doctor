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
      artifactLocation: {
        uri: path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/"),
      },
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
      ...(finding.impact === undefined ? {} : { impact: finding.impact }),
      ...(finding.remediationConstraints === undefined
        ? {}
        : { remediationConstraints: finding.remediationConstraints }),
      ...(finding.remediation === undefined ? {} : { remediation: finding.remediation }),
      ...(finding.verification === undefined ? {} : { verification: finding.verification }),
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
      properties: {
        auditScope: result.auditScope,
        domainCoverage: result.domainCoverage,
        ...(result.coverage === undefined ? {} : { coverage: result.coverage }),
      },
    }],
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
