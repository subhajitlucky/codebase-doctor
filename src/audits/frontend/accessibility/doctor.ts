import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";

const DOCTOR_ID = "frontend/accessibility";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

type JsonLikeObject = Record<string, unknown>;

export interface AccessibilityDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindings?: number;
}

interface ElementSite {
  readonly element: string;
  readonly line?: number;
  readonly column?: number;
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

function attributeNames(node: JsonLikeObject): { names: Set<string>; spread: boolean } {
  const names = new Set<string>();
  let spread = false;
  const attributes = Array.isArray(node["attributes"]) ? node["attributes"] : [];
  for (const attribute of attributes) {
    if (!isObject(attribute)) continue;
    if (nodeType(attribute) === "JSXSpreadAttribute") {
      spread = true;
      continue;
    }
    const name = nameOf(isObject(attribute["name"]) ? attribute["name"] : undefined);
    if (name !== undefined) names.add(name.toLowerCase());
  }
  return { names, spread };
}

function positiveTabIndex(node: JsonLikeObject): boolean {
  const attributes = Array.isArray(node["attributes"]) ? node["attributes"] : [];
  for (const attribute of attributes) {
    if (!isObject(attribute)) continue;
    const name = nameOf(isObject(attribute["name"]) ? attribute["name"] : undefined);
    if (name?.toLowerCase() !== "tabindex") continue;
    const value = isObject(attribute["value"]) ? attribute["value"] : undefined;
    if (nodeType(value) === "JSXExpressionContainer") {
      const expression = isObject(value?.["expression"]) ? value["expression"] : undefined;
      if (nodeType(expression) === "NumericLiteral" && typeof expression?.["value"] === "number") {
        return expression["value"] > 0;
      }
      return false;
    }
    const literal = typeof attribute["value"] === "string"
      ? attribute["value"]
      : isObject(attribute["value"]) && typeof attribute["value"]["value"] === "string"
        ? attribute["value"]["value"] as string
        : undefined;
    return literal !== undefined && /^\d+$/u.test(literal) && Number.parseInt(literal, 10) > 0;
  }
  return false;
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

export function isHtmlPath(path: string): boolean {
  return [".html", ".htm"].includes(posix.extname(path).toLowerCase());
}

interface FindingSpec {
  readonly ruleId: string;
  readonly severity: Finding["severity"];
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly identity: string;
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
    impact: "Assistive technology users lose an accessible name or a predictable navigation order for this element.",
    remediationConstraints: [
      "Preserve the rendered layout and component API.",
      "Provide an intentional accessible name; use empty alt text only for decorative images.",
    ],
    remediation: spec.ruleId === "img-missing-alt"
      ? "Add an alt attribute describing the image, or alt=\"\" when the image is decorative."
      : spec.ruleId === "iframe-missing-title"
        ? "Add a title attribute that describes the embedded content."
        : spec.ruleId === "html-missing-lang"
          ? "Add a lang attribute to the html element using the page's primary language."
          : "Use tabIndex 0 or rely on the natural document order instead of a positive tab index.",
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected: "The finding fingerprint is absent and frontend/accessibility coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${spec.ruleId}`,
      location: findingLocation,
      identity: spec.identity,
    }),
  };
}

function analyzeJsx(path: string, source: string): { elementsExamined: number; findings: Omit<FindingSpec, "ruleId">[] & never[] } | "parse-failed" {
  return "parse-failed";
}

export interface AccessibilityAnalysis {
  readonly elementsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

export function analyzeJsxAccessibility(path: string, source: string, changed: boolean): AccessibilityAnalysis {
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
      const element = nameOf(isObject(node["name"]) ? node["name"] : undefined);
      if (element !== undefined) {
        const lower = element.toLowerCase();
        const location = safeLocation(node);
        if (lower === "img" || lower === "iframe" || lower === "html") {
          elementsExamined += 1;
          const { names, spread } = attributeNames(node);
          if (lower === "img" && !names.has("alt") && !spread) {
            findings.push(findingFor(path, {
              ruleId: "img-missing-alt",
              severity: "medium",
              title: "Image element has no alt attribute",
              message: "A JSX img element is rendered without an alt attribute and without spread props that could supply one.",
              detail: "img element without alt",
              identity: `img:${location.line ?? 0}:${location.column ?? 0}`,
            }, location, changed));
          }
          if (lower === "iframe" && !names.has("title") && !spread) {
            findings.push(findingFor(path, {
              ruleId: "iframe-missing-title",
              severity: "medium",
              title: "Iframe element has no title attribute",
              message: "A JSX iframe element is rendered without a title attribute and without spread props that could supply one.",
              detail: "iframe element without title",
              identity: `iframe:${location.line ?? 0}:${location.column ?? 0}`,
            }, location, changed));
          }
          if (lower === "html" && !names.has("lang") && !spread) {
            findings.push(findingFor(path, {
              ruleId: "html-missing-lang",
              severity: "medium",
              title: "Document html element has no lang attribute",
              message: "The root html element is rendered without a lang attribute.",
              detail: "html element without lang",
              identity: `html:${location.line ?? 0}:${location.column ?? 0}`,
            }, location, changed));
          }
        }
        if (positiveTabIndex(node)) {
          elementsExamined += 1;
          findings.push(findingFor(path, {
            ruleId: "positive-tabindex",
            severity: "medium",
            title: "Positive tabIndex overrides natural focus order",
            message: "A JSX element uses a positive tabIndex, which forces a custom focus order.",
            detail: "element with positive tabIndex",
            identity: `tabindex:${location.line ?? 0}:${location.column ?? 0}`,
          }, location, changed));
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) visit(child);
    }
  };

  visit(ast);
  return { elementsExamined, findings: sortFindings(findings), limitations: [] };
}

export function analyzeHtmlAccessibility(path: string, content: string, changed: boolean): AccessibilityAnalysis {
  const source = content.replace(/<!--[\s\S]*?-->/gu, "");
  const findings: Finding[] = [];
  let elementsExamined = 0;

  const lineAt = (offset: number): number => {
    let line = 1;
    for (let index = 0; index < offset && index < source.length; index += 1) {
      if (source[index] === "\n") line += 1;
    }
    return line;
  };

  const html = /<html\b[^>]*>/iu.exec(source);
  if (html !== null) {
    elementsExamined += 1;
    if (!/\blang\s*=/iu.test(html[0])) {
      findings.push(findingFor(path, {
        ruleId: "html-missing-lang",
        severity: "medium",
        title: "Document html element has no lang attribute",
        message: "The html element has no lang attribute, so assistive technology cannot select the correct language.",
        detail: "html element without lang",
        identity: `html:${lineAt(html.index)}`,
      }, { line: lineAt(html.index) }, changed));
    }
  }

  const tagPattern = /<(img|iframe)\b[^>]*>/giu;
  for (const match of source.matchAll(tagPattern)) {
    const tag = match[0];
    const element = (match[1] ?? "").toLowerCase();
    elementsExamined += 1;
    const line = lineAt(match.index ?? 0);
    if (element === "img" && !/\balt\s*=/iu.test(tag)) {
      findings.push(findingFor(path, {
        ruleId: "img-missing-alt",
        severity: "medium",
        title: "Image element has no alt attribute",
        message: "An img element is rendered without an alt attribute.",
        detail: "img element without alt",
        identity: `img:${line}`,
      }, { line }, changed));
    }
    if (element === "iframe" && !/\btitle\s*=/iu.test(tag)) {
      findings.push(findingFor(path, {
        ruleId: "iframe-missing-title",
        severity: "medium",
        title: "Iframe element has no title attribute",
        message: "An iframe element is rendered without a title attribute.",
        detail: "iframe element without title",
        identity: `iframe:${line}`,
      }, { line }, changed));
    }
  }

  return { elementsExamined, findings: sortFindings(findings), limitations: [] };
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

export function createAccessibilityDoctor(options: AccessibilityDoctorOptions = {}): Doctor {
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
      const candidates = snapshot.files
        .filter((file) => file.kind === "file" && (isJsxPath(file.path) || isHtmlPath(file.path)))
        .map((file) => file.path)
        .sort();
      if (candidates.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: [coverage("not-applicable", snapshot.auditScope.mode, 0, 0, 0, [])],
          durationMs: Date.now() - startedAt,
        };
      }

      const limitations: string[] = [];
      const findings: Finding[] = [];
      let filesExamined = 0;
      let elementsExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(`Accessibility audit finding limit of ${maxFindings} was reached; remaining files were not reported.`);
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte accessibility audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(`Accessibility audit total content limit of ${maxTotalBytes} bytes was reached; remaining files were not examined.`);
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
        const analysis = isJsxPath(path)
          ? analyzeJsxAccessibility(path, content, snapshot.auditScope.mode === "changed")
          : analyzeHtmlAccessibility(path, content, snapshot.auditScope.mode === "changed");
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
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
