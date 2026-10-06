import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";
import { selectChangedCandidates } from "../../../scope/changed-files.js";

const DOCTOR_ID = "backend/api";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

const SQL_MODULES = new Set([
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "better-sqlite3",
  "sqlite3",
]);
const SQL_METHODS = new Set(["query", "execute"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const SHELL_METHODS = new Set(["exec", "execSync"]);
const ARG_SEPARATED_METHODS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);

type JsonLikeObject = Record<string, unknown>;

export interface BackendApiDoctorOptions {
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

function literalValue(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  return typeof node["value"] === "string" ? node["value"] : undefined;
}

function propertyKeyName(property: JsonLikeObject): string | undefined {
  const key = isObject(property["key"]) ? property["key"] : undefined;
  if (key === undefined) return undefined;
  return nodeType(key) === "StringLiteral"
    ? literalValue(key)
    : (key["name"] as string | undefined);
}

function safeLocation(node: JsonLikeObject): { line?: number; column?: number } {
  const loc = isObject(node["loc"]) ? node["loc"] : undefined;
  const start = isObject(loc?.["start"]) ? loc["start"] : undefined;
  return {
    ...(typeof start?.["line"] === "number" ? { line: start["line"] as number } : {}),
    ...(typeof start?.["column"] === "number" ? { column: (start["column"] as number) + 1 } : {}),
  };
}

export function isBackendSourcePath(path: string): boolean {
  return [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
  ].includes(posix.extname(path).toLowerCase());
}

function parserPlugins(path: string): ParserPlugin[] {
  const extension = posix.extname(path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  // JSX stays off for plain .ts files, where `<T>(x) => x` is a generic
  // function rather than a JSX element.
  if ([".jsx", ".tsx"].includes(extension)) plugins.push("jsx");
  plugins.push("decorators-legacy");
  return plugins;
}

interface ModuleBinding {
  readonly package: string;
  /** Imported member or constructed class behind the local name. */
  readonly member?: string;
}

interface CalleeTarget {
  readonly object?: string;
  readonly property?: string;
}

interface ResolvedCall {
  readonly package: string;
  readonly method?: string;
}

/**
 * Local names that provably resolve to an audited package, plus instance
 * names created with `new BoundClass()` where the class itself is bound.
 * A rule only fires for a call whose receiver provably resolves, so an
 * unrelated local `query` or `exec` helper is never reported.
 */
function collectModuleBindings(ast: JsonLikeObject): Map<string, ModuleBinding> {
  const bindings = new Map<string, ModuleBinding>();

  const bindLocal = (source: string, local: string, member?: string): void => {
    bindings.set(local, { package: source, ...(member === undefined ? {} : { member }) });
  };

  const bindLocals = (source: string, node: JsonLikeObject | undefined): void => {
    if (node === undefined) return;
    switch (nodeType(node)) {
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier": {
        const local = isObject(node["local"]) ? node["local"] : undefined;
        if (typeof local?.name === "string") bindLocal(source, local.name);
        return;
      }
      case "ImportSpecifier": {
        const local = isObject(node["local"]) ? node["local"] : undefined;
        const imported = isObject(node["imported"]) ? node["imported"] : undefined;
        if (typeof local?.name !== "string") return;
        const member = nodeType(imported) === "StringLiteral"
          ? literalValue(imported)
          : typeof imported?.name === "string"
            ? imported.name
            : undefined;
        bindLocal(source, local.name, member);
        return;
      }
      case "ObjectPattern": {
        for (const property of Array.isArray(node["properties"]) ? node["properties"] : []) {
          if (!isObject(property)) continue;
          const value = property["value"];
          if (!isObject(value) || typeof value["name"] !== "string") continue;
          const member = propertyKeyName(property) ?? undefined;
          bindLocal(source, value.name, member);
        }
        return;
      }
      case "Identifier": {
        if (typeof node["name"] === "string") bindLocal(source, node.name);
        return;
      }
      default:
        return;
    }
  };

  const requireSource = (node: JsonLikeObject | undefined): string | undefined => {
    if (nodeType(node) !== "CallExpression") return undefined;
    const callee = isObject(node?.["callee"]) ? node["callee"] : undefined;
    if (nodeType(callee) !== "Identifier" || callee?.name !== "require") return undefined;
    const args = Array.isArray(node?.["arguments"]) ? node["arguments"] : [];
    return literalValue(args[0]);
  };

  const newTarget = (node: JsonLikeObject | undefined): { object: string; property?: string } | undefined => {
    if (nodeType(node) !== "NewExpression") return undefined;
    const callee = isObject(node?.["callee"]) ? node["callee"] : undefined;
    if (nodeType(callee) === "Identifier" && typeof callee?.name === "string") {
      return { object: callee.name };
    }
    if (nodeType(callee) === "MemberExpression" && callee?.computed === false) {
      const object = isObject(callee["object"]) ? callee["object"] : undefined;
      const property = isObject(callee["property"]) ? callee["property"] : undefined;
      if (typeof object?.name === "string" && typeof property?.name === "string") {
        return { object: object.name, property: property.name };
      }
    }
    return undefined;
  };

  const visitStatements = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visitStatements(entry);
      return;
    }
    const node = isObject(value) ? value : undefined;
    if (node === undefined) return;

    if (nodeType(node) === "ImportDeclaration") {
      const source = literalValue(node["source"]);
      if (source !== undefined) {
        for (const specifier of Array.isArray(node["specifiers"]) ? node["specifiers"] : []) {
          bindLocals(source, isObject(specifier) ? specifier : undefined);
        }
      }
      return;
    }

    if (nodeType(node) === "VariableDeclaration") {
      for (const declarator of Array.isArray(node["declarations"]) ? node["declarations"] : []) {
        if (!isObject(declarator)) continue;
        const id = isObject(declarator["id"]) ? declarator["id"] : undefined;
        const init = isObject(declarator["init"]) ? declarator["init"] : undefined;
        const required = requireSource(init);
        if (required !== undefined) {
          bindLocals(required, id);
          continue;
        }
        const target = newTarget(init);
        if (target !== undefined && id !== undefined && nodeType(id) === "Identifier") {
          const binding = bindings.get(target.object);
          if (binding !== undefined && typeof id["name"] === "string") {
            bindLocal(binding.package, id.name, target.property ?? binding.member);
          }
        }
      }
    }
  };

  const program = isObject(ast["program"]) ? ast["program"] : undefined;
  const body = Array.isArray(program?.["body"]) ? program["body"] : [];
  visitStatements(body);
  return bindings;
}

function calleeTarget(callee: JsonLikeObject | undefined): CalleeTarget | undefined {
  if (nodeType(callee) === "Identifier") {
    return typeof callee?.name === "string" ? { object: callee.name } : undefined;
  }
  if (nodeType(callee) === "MemberExpression" && callee?.computed === false) {
    const object = isObject(callee["object"]) ? callee["object"] : undefined;
    const property = isObject(callee["property"]) ? callee["property"] : undefined;
    if (typeof object?.name !== "string" || typeof property?.name !== "string") {
      return undefined;
    }
    return { object: object.name, property: property.name };
  }
  return undefined;
}

function resolveCall(
  target: CalleeTarget,
  bindings: ReadonlyMap<string, ModuleBinding>,
): ResolvedCall | undefined {
  if (target.object === undefined) return undefined;
  const binding = bindings.get(target.object);
  if (binding === undefined) return undefined;
  const method = target.property ?? binding.member;
  return { package: binding.package, ...(method === undefined ? {} : { method }) };
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

function findingFor(
  path: string,
  spec: FindingSpec,
  location: { line?: number; column?: number },
  changed: boolean,
): Finding {
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
    category: "backend",
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
      expected: "The finding fingerprint is absent and backend/api coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${spec.ruleId}`,
      location: findingLocation,
      identity: spec.identity,
    }),
  };
}

export interface BackendApiAnalysis {
  readonly callsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

const READ_ONLY_CONSTRAINT =
  "Codebase Doctor never edits the query, command, or handler code.";
const PRESERVE_CONTRACT_CONSTRAINT =
  "Preserve the existing request and response contract for every client of this endpoint.";

/** A template literal is static only when it has no interpolated expressions. */
function isStaticTemplate(node: JsonLikeObject): boolean {
  if (nodeType(node) !== "TemplateLiteral") return false;
  const expressions = Array.isArray(node["expressions"]) ? node["expressions"] : [];
  return expressions.length === 0;
}

function isStringLiteral(node: JsonLikeObject | undefined): boolean {
  return nodeType(node) === "StringLiteral";
}

/**
 * Deterministic, offline backend API analysis. Rules fire only for calls whose
 * receiver provably resolves to an audited database or process package, and
 * only for query or command text that is observably dynamic. Anything whose
 * shape cannot be resolved statically is a coverage limitation, never a guess.
 */
export function analyzeBackendApi(
  path: string,
  source: string,
  changed: boolean,
): BackendApiAnalysis {
  let ast: unknown;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: path,
      plugins: parserPlugins(path),
      attachComment: false,
      errorRecovery: false,
    });
  } catch {
    return {
      callsExamined: 0,
      findings: [],
      limitations: [`${path}: backend source could not be parsed.`],
    };
  }

  const root = isObject(ast) ? ast : undefined;
  if (root === undefined) {
    return {
      callsExamined: 0,
      findings: [],
      limitations: [`${path}: backend source could not be parsed.`],
    };
  }

  const bindings = collectModuleBindings(root);
  const findings: Finding[] = [];
  const limitations: string[] = [];
  let callsExamined = 0;

  interface CallSite {
    readonly node: JsonLikeObject;
    readonly target: CalleeTarget;
    readonly line?: number;
    readonly column?: number;
  }
  const sqlCalls: CallSite[] = [];
  const shellCalls: CallSite[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const node = isObject(value) ? value : undefined;
    if (node === undefined) return;

    if (nodeType(node) === "CallExpression") {
      const target = calleeTarget(isObject(node["callee"]) ? node["callee"] : undefined);
      if (target !== undefined) {
        callsExamined += 1;
        const resolved = resolveCall(target, bindings);
        if (resolved !== undefined && SQL_MODULES.has(resolved.package) &&
          resolved.method !== undefined && SQL_METHODS.has(resolved.method)) {
          sqlCalls.push({ node, target, ...safeLocation(node) });
        } else if (resolved !== undefined && CHILD_PROCESS_MODULES.has(resolved.package) &&
          resolved.method !== undefined &&
          (SHELL_METHODS.has(resolved.method) || ARG_SEPARATED_METHODS.has(resolved.method))) {
          shellCalls.push({ node, target, ...safeLocation(node) });
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) visit(child);
    }
  };

  visit(root);

  const siteArguments = (site: CallSite): unknown[] => {
    const args = site.node["arguments"];
    return Array.isArray(args) ? args : [];
  };

  for (const site of sqlCalls) {
    const [first, second] = siteArguments(site);
    const text = isObject(first) ? first : undefined;
    if (text === undefined) {
      limitations.push(`${path}:${site.line ?? 0}: SQL query text is absent.`);
      continue;
    }
    if (isStringLiteral(text) || isStaticTemplate(text)) continue;
    if (nodeType(text) === "BinaryExpression" || nodeType(text) === "TemplateLiteral") {
      const parameterized = isObject(second) && nodeType(second) === "ArrayExpression";
      if (parameterized && nodeType(text) !== "TemplateLiteral") continue;
      findings.push(findingFor(path, {
        ruleId: "sql-string-concat-query",
        severity: "high",
        title: "SQL query text is built by string concatenation",
        message: "A database query is constructed by concatenating or interpolating values into the SQL text instead of passing them as parameters, so attacker-controlled input can alter the query.",
        detail: "database query with dynamically constructed SQL text",
        identity: `sql:${site.line ?? 0}:${site.column ?? 0}`,
        impact: "Attacker-controlled input can escape the intended query structure and read, modify, or delete database contents.",
        remediationConstraints: [
          "Keep the query semantics and result shape identical for existing callers.",
          PRESERVE_CONTRACT_CONSTRAINT,
          READ_ONLY_CONSTRAINT,
        ],
        remediation: "Move every interpolated value into a parameter binding (for example pool.query(text, values)) and keep the SQL text a static literal.",
      }, site, changed));
      continue;
    }
    limitations.push(
      `${path}:${site.line ?? 0}: SQL query text could not be resolved statically, so injection analysis was withheld.`,
    );
  }

  for (const site of shellCalls) {
    const resolved = resolveCall(site.target, bindings);
    const method = resolved?.method ?? "";
    if (ARG_SEPARATED_METHODS.has(method)) {
      if ((method === "spawn" || method === "spawnSync") && usesShellOption(siteArguments(site))) {
        findings.push(execFinding(path, site, "shell option enabled", changed));
      }
      continue;
    }
    const [first] = siteArguments(site);
    const command = isObject(first) ? first : undefined;
    if (command === undefined) {
      limitations.push(`${path}:${site.line ?? 0}: shell command is absent.`);
      continue;
    }
    if (isStringLiteral(command) || isStaticTemplate(command)) continue;
    findings.push(execFinding(path, site, "dynamically constructed command", changed));
  }

  return {
    callsExamined,
    findings: sortFindings(findings),
    limitations: [...new Set(limitations)].sort(),
  };
}

function usesShellOption(args: readonly unknown[]): boolean {
  for (const arg of args) {
    if (!isObject(arg) || nodeType(arg) !== "ObjectExpression") continue;
    for (const property of Array.isArray(arg["properties"]) ? arg["properties"] : []) {
      if (!isObject(property) || nodeType(property) === "SpreadElement") continue;
      if (propertyKeyName(property) !== "shell") continue;
      const value = property["value"];
      if (isObject(value) && nodeType(value) === "BooleanLiteral" && value["value"] === true) {
        return true;
      }
    }
  }
  return false;
}

function execFinding(
  path: string,
  site: { line?: number; column?: number },
  detail: string,
  changed: boolean,
): Finding {
  return findingFor(path, {
    ruleId: "child-process-exec-dynamic",
    severity: "high",
    title: "Shell command is constructed dynamically",
    message: "A shell is executed with a dynamically constructed command instead of a static literal or an argument-separated invocation, so attacker-controlled input can inject additional commands.",
    detail: `child_process execution with ${detail}`,
    identity: `exec:${site.line ?? 0}:${site.column ?? 0}`,
    impact: "Attacker-controlled input can escape the intended command and execute arbitrary shell commands with the process privileges.",
    remediationConstraints: [
      "Keep the intended command behavior identical for legitimate inputs.",
      "Never pass unsanitized input to a shell, even after quoting.",
      READ_ONLY_CONSTRAINT,
    ],
    remediation: "Replace the shell invocation with an argument-separated call such as execFile(command, args), or restrict the command to a static literal.",
  }, site, changed);
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  callsExamined: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: callsExamined,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createBackendApiDoctor(options: BackendApiDoctorOptions = {}): Doctor {
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
        .filter((file) => file.kind === "file" && isBackendSourcePath(file.path))
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
          isBackendSourcePath,
          "backend API",
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
              [...limitations, "No changed backend files were selected; unchanged files were not independently re-audited."],
            )],
            durationMs: Date.now() - startedAt,
          };
        }
        scopeNotes.push("Changed scope examined selected current changed files only; unchanged files were not independently re-audited.");
      }
      const findings: Finding[] = [];
      let filesExamined = 0;
      let callsExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(
            `Backend API audit finding limit of ${maxFindings} was reached; remaining files were not reported.`,
          );
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte backend API audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(
            `Backend API audit total content limit of ${maxTotalBytes} bytes was reached; remaining files were not examined.`,
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
        const analysis = analyzeBackendApi(path, content, snapshot.auditScope.mode === "changed");
        callsExamined += analysis.callsExamined;
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
          callsExamined,
          Math.min(findings.length, maxFindings),
          [...limitations, ...scopeNotes],
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
