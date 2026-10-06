import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";
import { selectChangedCandidates } from "../../../scope/changed-files.js";

const DOCTOR_ID = "frontend/security";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

type JsonLikeObject = Record<string, unknown>;

export interface FrontendSecurityDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindings?: number;
}

function isObject(value: unknown): value is JsonLikeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeType(node: JsonLikeObject | undefined): string | undefined {
  return typeof node?.type === "string" ? node.type : undefined;
}

function nameOf(node: JsonLikeObject | undefined): string | undefined {
  if (nodeType(node) !== "JSXIdentifier") return undefined;
  return typeof node?.name === "string" ? node.name : undefined;
}

function safeLocation(node: JsonLikeObject): { line?: number; column?: number } {
  const loc = isObject(node["loc"]) ? node["loc"] : undefined;
  const start = isObject(loc?.["start"]) ? loc["start"] : undefined;
  return {
    ...(typeof start?.["line"] === "number" ? { line: start["line"] as number } : {}),
    ...(typeof start?.["column"] === "number" ? { column: (start["column"] as number) + 1 } : {}),
  };
}

function jsxPlugins(path: string): ParserPlugin[] {
  const extension = posix.extname(path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  plugins.push("jsx", "decorators-legacy");
  return plugins;
}

export function isJsxPath(path: string): boolean {
  return [".jsx", ".tsx"].includes(posix.extname(path).toLowerCase());
}

interface FindingSpec {
  readonly ruleId: string;
  readonly severity: Finding["severity"];
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly identity: string;
  readonly impact: string;
  readonly remediationConstraints: readonly string[];
  readonly remediation: string;
}

function findingFor(path: string, spec: FindingSpec, location: { line?: number; column?: number }, changed: boolean): Finding {
  const findingLocation = {
    path,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
  };
  return {
    ruleId: `${DOCTOR_ID}/${spec.ruleId}`,
    doctorId: DOCTOR_ID,
    severity: spec.severity,
    confidence: "high",
    category: "frontend",
    title: spec.title,
    message: spec.message,
    location: findingLocation,
    evidence: [{ type: "file", path, detail: spec.detail }],
    impact: spec.impact,
    remediationConstraints: [...spec.remediationConstraints],
    remediation: spec.remediation,
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected: "The finding fingerprint is absent and frontend/security coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${spec.ruleId}`,
      location: findingLocation,
      identity: spec.identity,
    }),
  };
}

export interface FrontendSecurityAnalysis {
  readonly elementsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

/** Calls that prove the HTML was sanitized before rendering. */
function isSanitizerCall(node: JsonLikeObject | undefined): boolean {
  if (nodeType(node) !== "CallExpression") return false;
  const callee = isObject(node?.["callee"]) ? node["callee"] : undefined;
  if (nodeType(callee) === "MemberExpression" && callee?.computed === false) {
    const object = isObject(callee["object"]) ? callee["object"] : undefined;
    const property = isObject(callee["property"]) ? callee["property"] : undefined;
    return object?.name === "DOMPurify" && property?.name === "sanitize";
  }
  return nodeType(callee) === "Identifier" && callee?.name === "sanitizeHtml";
}

/**
 * Deterministic, offline analysis of raw-HTML rendering sinks. A finding
 * fires only for a `dangerouslySetInnerHTML` attribute whose value is
 * observably dynamic without a provable sanitizer call; static literals are
 * safe, and spread props suppress the check because the attribute set cannot
 * be resolved.
 */
export function analyzeJsxSecurity(path: string, source: string, changed: boolean): FrontendSecurityAnalysis {
  let ast: unknown;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: path,
      plugins: jsxPlugins(path),
      attachComment: false,
      errorRecovery: false,
    });
  } catch {
    return { elementsExamined: 0, findings: [], limitations: [`${path}: JSX source could not be parsed.`] };
  }

  const findings: Finding[] = [];
  const limitations: string[] = [];
  const visited = new WeakSet<object>();
  let elementsExamined = 0;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const node = isObject(value) ? value : undefined;
    if (node === undefined || visited.has(node)) return;
    visited.add(node);

    if (nodeType(node) === "JSXOpeningElement") {
      const attributes = Array.isArray(node["attributes"]) ? node["attributes"] : [];
      const spread = attributes.some((attribute) =>
        isObject(attribute) && nodeType(attribute) === "JSXSpreadAttribute"
      );
      for (const attribute of attributes) {
        if (!isObject(attribute)) continue;
        const name = nameOf(isObject(attribute["name"]) ? attribute["name"] : undefined);
        if (name?.toLowerCase() !== "dangerouslysetinnerhtml") continue;
        if (spread) continue;
        elementsExamined += 1;
        const location = safeLocation(attribute);
        const container = isObject(attribute["value"]) ? attribute["value"] : undefined;
        if (nodeType(container) !== "JSXExpressionContainer") continue;
        const expression = isObject(container?.["expression"]) ? container["expression"] : undefined;
        if (nodeType(expression) !== "ObjectExpression") {
          limitations.push(
            `${path}:${location.line ?? 0}: dangerouslySetInnerHTML shape could not be resolved statically.`,
          );
          continue;
        }
        const html = Array.isArray(expression?.["properties"])
          ? expression["properties"].find((property) => {
            if (!isObject(property) || nodeType(property) === "SpreadElement") return false;
            const key = isObject(property["key"]) ? property["key"] : undefined;
            const keyName = nodeType(key) === "Identifier"
              ? key?.name
              : nodeType(key) === "StringLiteral" && typeof key?.value === "string"
                ? key.value
                : undefined;
            return keyName === "__html";
          })
          : undefined;
        if (html === undefined || !isObject(html)) {
          limitations.push(
            `${path}:${location.line ?? 0}: dangerouslySetInnerHTML shape could not be resolved statically.`,
          );
          continue;
        }
        const value = isObject(html["value"]) ? html["value"] : undefined;
        if (nodeType(value) === "StringLiteral") continue;
        if (isSanitizerCall(value)) continue;
        findings.push(findingFor(path, {
          ruleId: "dangerously-set-inner-html",
          severity: "medium",
          title: "Raw HTML is rendered without a provable sanitizer",
          message: "A dangerouslySetInnerHTML attribute renders a dynamically computed value without a provable sanitizer call, so attacker-reachable data would execute as script in the page.",
          detail: "dangerouslySetInnerHTML with a dynamic value and no sanitizer call",
          identity: `dangerous-html:${location.line ?? 0}:${location.column ?? 0}`,
          impact: "Attacker-controlled markup or script reaching this sink executes in the application's origin with full access to the session.",
          remediationConstraints: [
            "Preserve the rendered output for legitimate content.",
            "Codebase Doctor never edits the component.",
          ],
          remediation: "Render the value as a React child instead of raw HTML, or pass it through an explicit sanitizer call such as DOMPurify.sanitize at this site.",
        }, location, changed));
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) visit(child);
    }
  };

  visit(ast);

  return {
    elementsExamined,
    findings: sortFindings(findings),
    limitations: [...new Set(limitations)].sort(),
  };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  elementsExamined: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: elementsExamined,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createFrontendSecurityDoctor(options: FrontendSecurityDoctorOptions = {}): Doctor {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const changed = snapshot.auditScope.mode === "changed";
      const allCandidates = snapshot.files
        .filter((file) => file.kind === "file" && isJsxPath(file.path))
        .map((file) => file.path)
        .sort();
      if (allCandidates.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: [coverage("not-applicable", snapshot.auditScope.mode, 0, 0, 0, [])],
          durationMs: Date.now() - startedAt,
        };
      }

      const limitations: string[] = [];
      const scopeNotes: string[] = [];
      let candidates = allCandidates;
      if (changed) {
        const selection = selectChangedCandidates(
          snapshot.auditScope.changes,
          snapshot.files,
          isJsxPath,
          "frontend security",
        );
        candidates = [...selection.candidates];
        limitations.push(...selection.limitations);
        if (candidates.length === 0) {
          return {
            status: "completed",
            findings: [],
            coverage: [coverage(
              "not-selected",
              snapshot.auditScope.mode,
              0,
              0,
              0,
              [...limitations, "No changed frontend files were selected; unchanged files were not independently re-audited."],
            )],
            durationMs: Date.now() - startedAt,
          };
        }
        scopeNotes.push("Changed scope examined selected current changed files only; unchanged files were not independently re-audited.");
      }
      const findings: Finding[] = [];
      let filesExamined = 0;
      let elementsExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(
            `Frontend security audit finding limit of ${maxFindings} was reached; remaining files were not reported.`,
          );
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte frontend security audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(
            `Frontend security audit total content limit of ${maxTotalBytes} bytes was reached; remaining files were not examined.`,
          );
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
        } catch {
          limitations.push(`${path}: source file could not be read.`);
          continue;
        }
        totalBytes += bytes.byteLength;
        filesExamined += 1;
        const content = Buffer.from(bytes).toString("utf8");
        const analysis = analyzeJsxSecurity(path, content, snapshot.auditScope.mode === "changed");
        elementsExamined += analysis.elementsExamined;
        findings.push(...analysis.findings);
        limitations.push(...analysis.limitations);
      }

      return {
        status: "completed",
        findings: sortFindings(findings).slice(0, maxFindings),
        coverage: [coverage(
          limitations.length > 0 ? "partial" : "completed",
          snapshot.auditScope.mode,
          filesExamined,
          elementsExamined,
          Math.min(findings.length, maxFindings),
          [...limitations, ...scopeNotes],
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
