import type { Finding, Severity } from "../core/findings.js";
import type { ReviewVerdict } from "../review/verdict.js";

export interface GithubAnnotationsOptions {
  verdict: ReviewVerdict;
  /** Maximum finding annotations emitted. Defaults to 100. */
  maxFindings?: number;
  excludedCount?: number;
}

const DEFAULT_MAX_FINDINGS = 100;
const MAX_MESSAGE_CHARS = 2000;

function commandFor(severity: Severity): "error" | "warning" | "notice" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "notice";
}

function escapeProperty(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function escapeMessage(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function oneLine(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_MESSAGE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * Render GitHub Actions workflow commands: one `::error|::warning|::notice`
 * annotation per in-scope finding plus a verdict notice. Annotations surface
 * inline on pull-request diffs without any network access.
 */
export function renderGithubAnnotations(
  findings: readonly Finding[],
  options: GithubAnnotationsOptions,
): string {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const shown = findings.slice(0, maxFindings);
  const lines: string[] = [];

  for (const finding of shown) {
    const command = commandFor(finding.severity);
    const properties: string[] = [];
    if (finding.location !== undefined) {
      properties.push(`file=${escapeProperty(finding.location.path)}`);
      if (finding.location.line !== undefined) {
        properties.push(`line=${finding.location.line}`);
      }
      if (finding.location.column !== undefined) {
        properties.push(`col=${finding.location.column}`);
      }
      properties.push(`title=${escapeProperty(`[${finding.severity}] ${finding.ruleId}`)}`);
    } else {
      properties.push(`title=${escapeProperty(`[${finding.severity}] ${finding.ruleId}`)}`);
    }
    const message = finding.remediation === undefined
      ? `${finding.title} — ${finding.message}`
      : `${finding.title} — ${finding.message} Remediation: ${finding.remediation}`;
    lines.push(`::${command} ${properties.join(",")}::${escapeMessage(oneLine(message))}`);
  }

  if (findings.length > shown.length) {
    lines.push(
      `::notice title=${escapeProperty("codebase-doctor review")}::` +
      escapeMessage(`${findings.length - shown.length} more finding(s) omitted; use --format json for full evidence.`),
    );
  }

  const excluded = options.excludedCount ?? 0;
  lines.push(
    `::notice title=${escapeProperty("codebase-doctor review")}::` +
    escapeMessage(
      `verdict=${options.verdict} findings-in-diff=${findings.length}` +
      (excluded > 0 ? ` omitted-outside-diff=${excluded}` : ""),
    ),
  );

  return `${lines.join("\n")}\n`;
}
