import type { Finding, Severity } from "../core/findings.js";
import type { ScanResult } from "../core/normalize.js";

export interface TextReportOptions {
  color?: boolean;
  isTTY?: boolean;
  noColor?: boolean;
}

const SEVERITY_COLORS: Record<Severity, number> = {
  info: 36,
  low: 34,
  medium: 33,
  high: 31,
  critical: 35,
};

function severityLabel(
  severity: Severity,
  colorEnabled: boolean,
): string {
  const label = `[${severity.toUpperCase()}]`;
  return colorEnabled ? `\u001b[${SEVERITY_COLORS[severity]}m${label}\u001b[0m` : label;
}

function location(finding: Finding): string | undefined {
  if (finding.location === undefined) return undefined;
  const line = finding.location.line === undefined ? "" : `:${finding.location.line}`;
  const column = finding.location.column === undefined ? "" : `:${finding.location.column}`;
  return `${finding.location.path}${line}${column}`;
}

function evidenceLines(finding: Finding): string[] {
  return finding.evidence.flatMap((evidence) => {
    if (evidence.type === "file" || evidence.type === "manifest") {
      return [`  Evidence: ${evidence.type} ${evidence.path} — ${evidence.detail}`];
    }
    if (evidence.type === "observation") {
      return [`  Evidence: observation — ${evidence.detail}`];
    }
    if (evidence.type === "database") {
      const scope = evidence.table === undefined
        ? evidence.schema
        : `${evidence.schema}.${evidence.table}`;
      const policy = evidence.policy === undefined ? "" : ` policy \"${evidence.policy}\"`;
      return [`  Evidence: database ${scope}${policy} — ${evidence.detail}`];
    }
    const lines = [`  Evidence: command ${evidence.command} — exit ${evidence.exitCode}`];
    if (evidence.output !== undefined && evidence.output.length > 0) {
      lines.push(...evidence.output.split("\n").map((line) => `    ${line}`));
    }
    return lines;
  });
}

export function renderTextReport(
  result: ScanResult,
  options: TextReportOptions = {},
): string {
  const colorEnabled = options.color === true && options.isTTY === true && options.noColor !== true;
  const lines = [
    `Codebase Doctor ${result.tool.version}`,
    `Repository: ${result.repository.root}`,
    "",
    "Projects",
  ];

  if (result.projects.length === 0) {
    lines.push("No supported project signals detected.");
  } else {
    for (const project of result.projects) {
      lines.push(`Project: ${project.root}`);
      lines.push(`  Ecosystems: ${project.ecosystems.join(", ") || "unknown"}`);
      lines.push(`  Languages: ${project.languages.join(", ") || "unknown"}`);
      if (project.frameworks.length > 0) {
        lines.push(`  Frameworks: ${project.frameworks.join(", ")}`);
      }
      if (project.packageManager !== undefined) {
        lines.push(`  Package manager: ${project.packageManager}`);
      }
      lines.push(`  Check support: ${project.executionSupport}`);
    }
  }

  lines.push("", "Planned checks");
  if (result.plannedChecks.length === 0) {
    lines.push("No supported checks detected.");
  } else {
    for (const check of result.plannedChecks) {
      lines.push(`Planned command: ${check.command} (${check.projectId})`);
    }
  }

  lines.push("", "Doctor runs");
  if (result.doctorRuns.length === 0) {
    lines.push("No doctors ran.");
  } else {
    for (const run of result.doctorRuns) {
      lines.push(`${run.doctorId}: ${run.status} (${run.findingCount} findings, ${run.durationMs} ms)`);
      if (run.skipReason !== null) lines.push(`  Reason: ${run.skipReason}`);
      if (run.error !== null) lines.push(`  Operational error: ${run.error.code} — ${run.error.message}`);
      for (const check of run.checkRuns) {
        const detail = check.reason ?? (check.exitCode === undefined ? "" : `exit ${check.exitCode}`);
        lines.push(`  Check: ${check.command} — ${check.status}${detail.length > 0 ? ` (${detail})` : ""}`);
      }
    }
  }

  lines.push("", "Findings");
  if (result.findings.length === 0) {
    lines.push("Clean scan: no findings.");
  } else {
    for (const finding of result.findings) {
      lines.push(`${severityLabel(finding.severity, colorEnabled)} ${finding.title} (${finding.ruleId})`);
      const findingLocation = location(finding);
      if (findingLocation !== undefined) lines.push(`  Location: ${findingLocation}`);
      lines.push(`  ${finding.message}`);
      lines.push(...evidenceLines(finding));
      if (finding.remediation !== undefined) {
        lines.push(`  Remediation: ${finding.remediation}`);
      }
    }
  }

  if (result.comparison !== undefined) {
    lines.push(
      "",
      "Baseline comparison",
      `New: ${result.comparison.new.length}; unchanged: ${result.comparison.unchanged.length}; resolved: ${result.comparison.resolved.length}`,
    );
  }

  const counts = result.summary.counts;
  lines.push(
    "",
    `Summary: ${result.summary.total} findings — critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}, info ${counts.info}`,
  );
  return `${lines.join("\n")}\n`;
}
