import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";

const DOCTOR_ID = "backend/auth";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

const CORS_MODULES = new Set(["cors", "express-cors", "@fastify/cors"]);
const SESSION_MODULES = new Set(["express-session", "cookie-session", "fastify-session"]);
const JWT_MODULES = new Set([
  "jsonwebtoken",
  "jose",
  "jwt-simple",
  "express-jwt",
  "@nestjs/jwt",
  "fastify-jwt",
]);

type JsonLikeObject = Record<string, unknown>;

export interface BackendAuthDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindings?: number;
}

function isObject(value: unknown): value is JsonLikeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeType(node: unknown): string | undefined {
  return isObject(node) && typeof node["type"] === "string" ? node["type"] : undefined;
}

/** Reads a string payload from a node whose `value` field is not statically typed. */
function literalValue(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  return typeof node["value"] === "string" ? node["value"] : undefined;
}

/** Reads the name of a property key from either an Identifier or a StringLiteral key. */
function propertyKeyName(property: JsonLikeObject): string | undefined {
  const key = isObject(property["key"]) ? property["key"] : undefined;
  if (key === undefined) return undefined;
  return nodeType(key) === "StringLiteral" ? literalValue(key) : (key["name"] as string | undefined);
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

/**
 * Local binding names that provably resolve to a given package, collected from
 * import declarations and CommonJS requires. A rule only fires for a call whose
 * callee is bound to the audited package, so an unrelated local `decode` helper
 * is never reported as a JWT call.
 */
/**
 * Local binding names that provably resolve to a given package, collected from
 * import declarations and CommonJS requires. A rule only fires for a call whose
 * callee is bound to the audited package, so an unrelated local `decode` helper
 * is never reported as a JWT call.
 */
interface ModuleBinding {
  readonly package: string;
  /** Imported member name when the local name is a specific named import. */
  readonly member?: string;
}

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
        const source = requireSource(isObject(declarator["init"]) ? declarator["init"] : undefined);
        if (source !== undefined) bindLocals(source, id);
      }
    }
  };

  const program = isObject(ast["program"]) ? ast["program"] : undefined;
  const body = Array.isArray(program?.["body"]) ? program["body"] : [];
  visitStatements(body);
  return bindings;
}

interface CalleeTarget {
  /** Local binding for the receiver of a member call, or the callee itself. */
  readonly object?: string;
  /** Property name for a member call. */
  readonly property?: string;
}

interface ResolvedCall {
  readonly package: string;
  /** Member being invoked, whether written as a property or bound as a named import. */
  readonly method?: string;
}

/**
 * Resolves a callee to the package it provably came from. A bare call to a
 * named import reports that import's own name as the invoked member, so
 * `import { verify as vfy }` still identifies a verify call.
 */
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

function packageOf(
  target: CalleeTarget,
  bindings: ReadonlyMap<string, ModuleBinding>,
  packages: ReadonlySet<string>,
): string | undefined {
  const resolved = resolveCall(target, bindings);
  if (resolved === undefined || !packages.has(resolved.package)) return undefined;
  return resolved.package;
}

function booleanProperty(
  options: JsonLikeObject,
  name: string,
): { readonly value?: boolean; readonly unresolved: boolean; readonly present: boolean } {
  for (const property of Array.isArray(options["properties"]) ? options["properties"] : []) {
    if (!isObject(property)) continue;
    if (nodeType(property) === "SpreadElement") return { unresolved: true, present: true };
    if (propertyKeyName(property) !== name) continue;
    const value = property["value"];
    if (nodeType(value) === "BooleanLiteral" && typeof (value as JsonLikeObject)["value"] === "boolean") {
      return { value: (value as JsonLikeObject)["value"] as boolean, unresolved: false, present: true };
    }
    return { unresolved: true, present: true };
  }
  return { unresolved: false, present: false };
}

function wildcardOrigin(options: JsonLikeObject): { readonly wildcard: boolean; readonly unresolved: boolean } {
  for (const property of Array.isArray(options["properties"]) ? options["properties"] : []) {
    if (!isObject(property)) continue;
    if (nodeType(property) === "SpreadElement") return { wildcard: false, unresolved: true };
    if (propertyKeyName(property) !== "origin") continue;
    const value = property["value"];
    if (nodeType(value) === "StringLiteral") {
      // A literal origin is fully resolved: "*" is a wildcard, anything else
      // is an explicit allowlist of one origin.
      return { wildcard: literalValue(value) === "*", unresolved: false };
    }
    if (nodeType(value) === "BooleanLiteral" && (value as JsonLikeObject)["value"] === true) {
      // cors({ origin: true }) reflects the request Origin header back, which
      // behaves like a wildcard for credentialed requests.
      return { wildcard: true, unresolved: false };
    }
    // An allowlist of literal origins is fully resolvable, so it is neither a
    // wildcard nor a coverage limitation.
    if (nodeType(value) === "ArrayExpression") {
      const elements = Array.isArray((value as JsonLikeObject)["elements"])
        ? (value as JsonLikeObject)["elements"] as unknown[]
        : [];
      const literals = elements.map((element) => literalValue(element));
      if (literals.every((element) => typeof element === "string")) {
        return {
          wildcard: literals.some((element) => element === "*"),
          unresolved: false,
        };
      }
    }
    return { wildcard: false, unresolved: true };
  }
  return { wildcard: false, unresolved: false };
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
      expected: "The finding fingerprint is absent and backend/auth coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${spec.ruleId}`,
      location: findingLocation,
      identity: spec.identity,
    }),
  };
}

export interface BackendAuthAnalysis {
  readonly callsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

const READ_ONLY_CONSTRAINT =
  "Codebase Doctor never edits the middleware, handler, or session configuration.";
const PRESERVE_CONTRACT_CONSTRAINT =
  "Preserve the existing request and response contract for every client of this endpoint.";

/**
 * Deterministic, offline backend authentication analysis. Rules fire only for
 * calls whose callee provably resolves to the audited package, and every finding
 * rests on an observed construct rather than an inferred absence. Configuration
 * that cannot be resolved statically is reported as a coverage limitation.
 */
export function analyzeBackendAuth(
  path: string,
  source: string,
  changed: boolean,
): BackendAuthAnalysis {
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

  const noteCall = (node: JsonLikeObject): CalleeTarget | undefined => {
    callsExamined += 1;
    return calleeTarget(isObject(node["callee"]) ? node["callee"] : undefined);
  };

  const firstArgument = (node: JsonLikeObject): JsonLikeObject | undefined => {
    const args = Array.isArray(node["arguments"]) ? node["arguments"] : [];
    const first = args[0];
    return isObject(first) ? first : undefined;
  };

  // Pass 1: locate the security-relevant call sites so file-scoped rules such as
  // "jwt.decode without any jwt.verify in this file" can be decided with evidence.
  interface CallSite {
    readonly node: JsonLikeObject;
    readonly target: CalleeTarget;
    readonly line?: number;
    readonly column?: number;
  }
  const corsCalls: CallSite[] = [];
  const sessionCalls: CallSite[] = [];
  const jwtCalls: CallSite[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const node = isObject(value) ? value : undefined;
    if (node === undefined) return;

    if (nodeType(node) === "CallExpression") {
      const target = noteCall(node);
      if (target !== undefined) {
        const site: CallSite = { node, target, ...safeLocation(node) };
        if (packageOf(target, bindings, CORS_MODULES) !== undefined) corsCalls.push(site);
        else if (packageOf(target, bindings, SESSION_MODULES) !== undefined) sessionCalls.push(site);
        else if (packageOf(target, bindings, JWT_MODULES) !== undefined) jwtCalls.push(site);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) visit(child);
    }
  };

  visit(root);

  for (const site of corsCalls) {
    const options = firstArgument(site.node);
    if (options === undefined) {
      limitations.push(
        `${path}:${site.line ?? 0}: CORS middleware options could not be resolved statically.`,
      );
      continue;
    }
    if (nodeType(options) !== "ObjectExpression") {
      limitations.push(
        `${path}:${site.line ?? 0}: CORS middleware was configured with a non-literal options expression.`,
      );
      continue;
    }
    const origin = wildcardOrigin(options);
    const credentials = booleanProperty(options, "credentials");
    if (origin.unresolved || credentials.unresolved) {
      limitations.push(
        `${path}:${site.line ?? 0}: CORS origin or credentials configuration could not be resolved statically.`,
      );
      continue;
    }
    if (origin.wildcard && credentials.value === true) {
      findings.push(findingFor(path, {
        ruleId: "cors-wildcard-origin-with-credentials",
        severity: "high",
        title: "Wildcard CORS origin combined with credentialed requests",
        message: "CORS middleware is configured with a wildcard or reflected origin while credentials are enabled, so any origin can read authenticated responses.",
        detail: "CORS middleware with wildcard origin and credentials enabled",
        identity: `cors:${site.line ?? 0}:${site.column ?? 0}`,
        impact: "A malicious page can issue credentialed cross-origin requests and read authenticated API responses from a victim's browser session.",
        remediationConstraints: [
          "Allow only the origins the deployment actually serves.",
          "If the API is cookie-authenticated, keep credentials enabled and return an explicit origin allowlist instead of a wildcard.",
          READ_ONLY_CONSTRAINT,
        ],
        remediation: "Replace the wildcard or reflected origin with an explicit allowlist of the frontend origins that must call this API.",
      }, site, changed));
    }
  }

  for (const site of sessionCalls) {
    const options = firstArgument(site.node);
    if (options === undefined || nodeType(options) !== "ObjectExpression") continue;
    const cookie = Array.isArray(options["properties"])
      ? options["properties"].find((property) => {
        if (!isObject(property) || nodeType(property) === "SpreadElement") return false;
        const key = isObject(property["key"]) ? property["key"] : undefined;
        const keyName = nodeType(key) === "Identifier" || nodeType(key) === "StringLiteral"
          ? key?.name ?? key?.value
          : undefined;
        return keyName === "cookie";
      })
      : undefined;
    const cookieOptions = isObject(cookie) && isObject(cookie["value"]) ? cookie["value"] : undefined;
    if (cookieOptions === undefined || nodeType(cookieOptions) !== "ObjectExpression") continue;

    const secure = booleanProperty(cookieOptions, "secure");
    const httpOnly = booleanProperty(cookieOptions, "httpOnly");
    if (secure.unresolved || httpOnly.unresolved) {
      limitations.push(
        `${path}:${site.line ?? 0}: session cookie flags could not be resolved statically.`,
      );
      continue;
    }
    if (secure.value === false || httpOnly.value === false) {
      findings.push(findingFor(path, {
        ruleId: "session-cookie-security-disabled",
        severity: "high",
        title: "Session cookie security flag explicitly disabled",
        message: "Session cookie configuration explicitly disables a transport or script-access protection, so the session cookie can travel in cleartext or be read by injected script.",
        detail: "session cookie configured with a security flag set to false",
        identity: `session:${site.line ?? 0}:${site.column ?? 0}`,
        impact: "A session identifier can be intercepted in transit or stolen through script injection, yielding full account takeover.",
        remediationConstraints: [
          "Serve the API exclusively over HTTPS.",
          "Keep the cookie unreadable by client script unless a documented flow requires it.",
          READ_ONLY_CONSTRAINT,
        ],
        remediation: "Set the cookie secure flag and the httpOnly flag to true, and terminate TLS in front of this service.",
      }, site, changed));
    }
  }

  const memberOf = (site: CallSite): string | undefined =>
    resolveCall(site.target, bindings)?.method;
  const decodeCalls = jwtCalls.filter((site) => memberOf(site) === "decode");
  const verifyCalls = jwtCalls.filter((site) => memberOf(site) === "verify");
  for (const site of decodeCalls) {
    if (verifyCalls.length > 0) continue;
    findings.push(findingFor(path, {
      ruleId: "jwt-decode-without-verify",
      severity: "high",
      title: "JWT decoded without any signature verification in this file",
      message: "A token is decoded with a JWT decode call while the file contains no verify call, so the decoded claims are untrusted attacker-controlled input.",
      detail: "JWT decode call with no JWT verify call in the same file",
      identity: `jwt-decode:${site.line ?? 0}:${site.column ?? 0}`,
      impact: "An attacker can forge arbitrary token claims and reach authenticated behavior, because decoding never checks the signature.",
      remediationConstraints: [
        "Verify the token signature against the configured secret or public key before reading any claim.",
        PRESERVE_CONTRACT_CONSTRAINT,
        READ_ONLY_CONSTRAINT,
      ],
      remediation: "Verify the token with the JWT library's verify call before trusting decoded claims, or move verification into middleware that runs before this code.",
    }, site, changed));
  }

  for (const site of verifyCalls) {
    const args = Array.isArray(site.node["arguments"]) ? site.node["arguments"] : [];
    const optionsArg = args.length > 2 ? args[2] : undefined;
    const options = isObject(optionsArg) ? optionsArg : undefined;
    if (options !== undefined && nodeType(options) !== "ObjectExpression") {
      limitations.push(
        `${path}:${site.line ?? 0}: JWT verify options could not be resolved statically.`,
      );
      continue;
    }
    const algorithms = options === undefined
      ? { present: false }
      : booleanProperty(options, "algorithms");
    if (algorithms.present) continue;
    findings.push(findingFor(path, {
      ruleId: "jwt-verify-algorithm-unrestricted",
      severity: "medium",
      title: "JWT verify call does not restrict accepted algorithms",
      message: "A JWT verify call passes no algorithms allowlist, so the accepted algorithm is taken from the untrusted token header.",
      detail: "JWT verify call without an algorithms allowlist",
      identity: `jwt-verify:${site.line ?? 0}:${site.column ?? 0}`,
      impact: "An attacker may be able to select a weaker or unintended algorithm and bypass signature verification.",
      remediationConstraints: [
        "Pin the algorithms this deployment issues and accepts.",
        PRESERVE_CONTRACT_CONSTRAINT,
        READ_ONLY_CONSTRAINT,
      ],
      remediation: "Pass an explicit algorithms allowlist to the verify call, for example { algorithms: [\"HS256\"] }.",
    }, site, changed));
  }

  return {
    callsExamined,
    findings: sortFindings(findings),
    limitations: [...new Set(limitations)].sort(),
  };
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

export function createBackendAuthDoctor(options: BackendAuthDoctorOptions = {}): Doctor {
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
        .filter((file) => file.kind === "file" && isBackendSourcePath(file.path))
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
      let callsExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(
            `Backend auth audit finding limit of ${maxFindings} was reached; remaining files were not reported.`,
          );
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte backend auth audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(
            `Backend auth audit total content limit of ${maxTotalBytes} bytes was reached; remaining files were not examined.`,
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
        const analysis = analyzeBackendAuth(path, content, snapshot.auditScope.mode === "changed");
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
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}