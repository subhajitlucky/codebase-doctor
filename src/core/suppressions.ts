import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, Severity } from "./findings.js";

const DIRECTIVE_MARKER = "codebase-doctor-ignore";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_FILES = 200;

export interface SuppressionDirective {
  readonly targets: readonly string[];
  readonly reason: string;
  readonly line: number;
}

export interface SuppressedFinding {
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly doctorId: string;
  readonly severity: Severity;
  readonly location?: Finding["location"];
  readonly reason: string;
  readonly path: string;
  readonly directiveLine: number;
}

export interface SuppressionOutcome {
  readonly kept: Finding[];
  readonly suppressed: SuppressedFinding[];
  readonly limitations: string[];
}

export interface SuppressionOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
}

const DIRECTIVE_PATTERN = /codebase-doctor-ignore\s*:\s*([^\r\n]*)/u;

/**
 * Parse `codebase-doctor-ignore: rule-id [, ...] [-- reason]` directives from
 * one file's content. One directive per line; the reported line is 1-based.
 */
export function parseSuppressionDirectives(content: string): SuppressionDirective[] {
  const directives: SuppressionDirective[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = DIRECTIVE_PATTERN.exec(lines[index] ?? "");
    if (match?.[1] === undefined) continue;
    const [idsPart = "", ...reasonParts] = match[1].split(/(?:--|—)/u);
    const targets = idsPart
      .split(/[\s,]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (targets.length === 0) continue;
    directives.push({
      targets,
      reason: reasonParts.join("--").trim(),
      line: index + 1,
    });
  }
  return directives;
}

function directiveMatches(directive: SuppressionDirective, finding: Finding): boolean {
  return directive.targets.some((target) =>
    target === finding.ruleId ||
    target === finding.doctorId ||
    (target.endsWith("/*") && finding.ruleId.startsWith(target.slice(0, -1)))
  );
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/**
 * Partition findings into kept and acknowledged (suppressed) sets. A finding
 * with a line location is acknowledged only by a directive on its own line
 * or the line immediately above it; findings without a location can never be
 * acknowledged inline. Suppressed findings stay fully visible in the report's
 * `suppressed` section and still count as present for baseline and verify
 * comparisons — they are never reported as resolved.
 */
export async function applySuppressions(
  root: string,
  findings: readonly Finding[],
  options: SuppressionOptions = {},
): Promise<SuppressionOutcome> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const readSelectedFile = options.readFile ?? readFile;

  const byPath = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.location === undefined) continue;
    const scoped = byPath.get(finding.location.path) ?? [];
    scoped.push(finding);
    byPath.set(finding.location.path, scoped);
  }

  const kept: Finding[] = [...findings.filter((finding) => finding.location === undefined)];
  const suppressed: SuppressedFinding[] = [];
  const limitations: string[] = [];
  const orderedPaths = [...byPath.keys()].sort();

  if (orderedPaths.length > maxFiles) {
    limitations.push(
      `Suppression check examined the first ${maxFiles} of ${orderedPaths.length} files with findings; directives in the rest were ignored.`,
    );
  }

  for (const path of orderedPaths.slice(0, maxFiles)) {
    const scoped = byPath.get(path) ?? [];
    let content: string;
    try {
      const bytes = await readSelectedFile(join(root, ...path.split("/")));
      if (bytes.byteLength > maxFileBytes) {
        limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte suppression size limit; directives were ignored.`);
        kept.push(...scoped);
        continue;
      }
      if (isBinary(bytes)) {
        limitations.push(`${path}: binary content cannot carry suppression directives; directives were ignored.`);
        kept.push(...scoped);
        continue;
      }
      content = Buffer.from(bytes).toString("utf8");
    } catch {
      limitations.push(`${path}: file could not be read for suppression directives; findings were kept.`);
      kept.push(...scoped);
      continue;
    }

    const lines = content.split("\n");
    for (const finding of scoped) {
      const line = finding.location?.line;
      if (line === undefined) {
        kept.push(finding);
        continue;
      }
      const candidates = [
        { text: lines[line - 1], directiveLine: line },
        ...(line > 1 ? [{ text: lines[line - 2], directiveLine: line - 1 }] : []),
      ];
      let matched: { directive: SuppressionDirective; directiveLine: number } | undefined;
      for (const candidate of candidates) {
        if (candidate.text === undefined) continue;
        const directive = parseSuppressionDirectives(candidate.text)
          .find((entry) => directiveMatches(entry, finding));
        if (directive !== undefined) {
          matched = { directive, directiveLine: candidate.directiveLine };
          break;
        }
      }
      if (matched === undefined) {
        kept.push(finding);
        continue;
      }
      suppressed.push({
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        doctorId: finding.doctorId,
        severity: finding.severity,
        ...(finding.location === undefined ? {} : { location: { ...finding.location } }),
        reason: matched.directive.reason,
        path,
        directiveLine: matched.directiveLine,
      });
    }
  }

  suppressed.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );

  // Files past the examination cap keep every finding: an unexamined
  // directive can never silence a result.
  for (const path of orderedPaths.slice(maxFiles)) {
    kept.push(...(byPath.get(path) ?? []));
  }

  return { kept, suppressed, limitations: [...new Set(limitations)].sort() };
}
