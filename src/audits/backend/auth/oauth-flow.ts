import { posix } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import { tokenizeGo, type GoToken } from "../../../source-graph/go-parser.js";

type JsonLikeObject = Record<string, unknown>;

export interface OAuthCallbackFinding {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly identity: string;
  readonly detail: string;
}

export interface OAuthFlowAnalysis {
  readonly findings: readonly OAuthCallbackFinding[];
  readonly limitations: readonly string[];
  readonly candidatesExamined: number;
}

export function isGoSourcePath(path: string): boolean {
  return posix.extname(path).toLowerCase() === ".go";
}

function isObject(value: unknown): value is JsonLikeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeType(node: unknown): string | undefined {
  return isObject(node) && typeof node["type"] === "string" ? node["type"] : undefined;
}

function literalValue(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  return typeof node["value"] === "string" ? node["value"] : undefined;
}

function safeLocation(node: JsonLikeObject): { line?: number; column?: number } {
  const loc = isObject(node["loc"]) ? node["loc"] : undefined;
  const start = isObject(loc?.["start"]) ? loc["start"] : undefined;
  return {
    ...(typeof start?.["line"] === "number" ? { line: start["line"] as number } : {}),
    ...(typeof start?.["column"] === "number" ? { column: (start["column"] as number) + 1 } : {}),
  };
}

function parserPlugins(path: string): ParserPlugin[] {
  const extension = posix.extname(path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  if ([".jsx", ".tsx"].includes(extension)) plugins.push("jsx");
  plugins.push("decorators-legacy");
  return plugins;
}

function walk(value: unknown, visit: (node: JsonLikeObject) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  const node = isObject(value) ? value : undefined;
  if (node === undefined) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
    if (typeof child === "object" && child !== null) walk(child, visit);
  }
}

function propertyName(node: JsonLikeObject): string | undefined {
  if (node["computed"] === false) {
    const property = isObject(node["property"]) ? node["property"] : undefined;
    return typeof property?.name === "string" ? property.name : undefined;
  }
  const property = isObject(node["property"]) ? node["property"] : undefined;
  return literalValue(property);
}

function chainHasName(node: unknown, name: string): boolean {
  const current = isObject(node) ? node : undefined;
  if (current === undefined) return false;
  if (nodeType(current) === "Identifier" && current["name"] === name) return true;
  if (nodeType(current) === "MemberExpression") {
    const property = isObject(current["property"]) ? current["property"] : undefined;
    if (property?.["name"] === name) return true;
    return chainHasName(current["object"], name);
  }
  return false;
}

function hasQueryParam(handler: JsonLikeObject, param: string): boolean {
  let found = false;
  walk(handler, (node) => {
    if (found || nodeType(node) !== "MemberExpression") return;
    if (propertyName(node) !== param) return;
    if (chainHasName(node["object"], "query")) found = true;
  });
  return found;
}

function hasIdentifierOrString(handler: JsonLikeObject, names: ReadonlySet<string>): boolean {
  let found = false;
  walk(handler, (node) => {
    if (found) return;
    if (nodeType(node) === "Identifier" && typeof node["name"] === "string" && names.has(node.name)) {
      found = true;
      return;
    }
    if (nodeType(node) === "StringLiteral" && typeof node["value"] === "string" && names.has(node.value)) {
      found = true;
    }
  });
  return found;
}

const TOKEN_CALL_NAMES = new Set([
  "setAccessToken",
  "setToken",
  "setAccessTokenFromCode",
  "saveToken",
]);
const TOKEN_FIELD_NAMES = new Set(["accessToken", "access_token", "token"]);
const COOKIE_NAMES = new Set(["cookie", "cookies", "Set-Cookie", "oauth_state", "csrf"]);
const STATE_NAMES = new Set(["state", "State", "oauth_state", "csrf"]);

interface JsFunction {
  readonly name: string;
  readonly node: JsonLikeObject;
}

function collectJsFunctions(ast: JsonLikeObject): Map<string, JsonLikeObject[]> {
  const functions = new Map<string, JsonLikeObject[]>();
  const add = (name: string, node: JsonLikeObject): void => {
    const existing = functions.get(name) ?? [];
    existing.push(node);
    functions.set(name, existing);
  };
  walk(ast, (node) => {
    if (nodeType(node) === "FunctionDeclaration") {
      const id = isObject(node["id"]) ? node["id"] : undefined;
      if (typeof id?.name === "string") add(id.name, node);
      return;
    }
    if (nodeType(node) === "VariableDeclarator") {
      const id = isObject(node["id"]) ? node["id"] : undefined;
      const init = isObject(node["init"]) ? node["init"] : undefined;
      if (typeof id?.name !== "string" || init === undefined) return;
      if (["ArrowFunctionExpression", "FunctionExpression"].includes(nodeType(init) ?? "")) {
        add(id.name, init);
      }
    }
  });
  return functions;
}

function resolveJsHandler(
  node: unknown,
  functions: ReadonlyMap<string, JsonLikeObject[]>,
): JsonLikeObject | undefined {
  const current = isObject(node) ? node : undefined;
  if (current === undefined) return undefined;
  if (["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"].includes(nodeType(current) ?? "")) {
    return current;
  }
  if (nodeType(current) === "Identifier" && typeof current["name"] === "string") {
    return functions.get(current.name)?.[0];
  }
  return undefined;
}

function jsHasTokenAssignment(
  handler: JsonLikeObject,
  functions: ReadonlyMap<string, JsonLikeObject[]>,
  depth = 0,
): boolean {
  let found = false;
  walk(handler, (node) => {
    if (found) return;
    if (nodeType(node) === "AssignmentExpression") {
      const left = isObject(node["left"]) ? node["left"] : undefined;
      if (left !== undefined && nodeType(left) === "MemberExpression" && TOKEN_FIELD_NAMES.has(propertyName(left) ?? "")) {
        found = true;
        return;
      }
    }
    if (nodeType(node) !== "CallExpression") return;
    const callee = isObject(node["callee"]) ? node["callee"] : undefined;
    if (callee === undefined) return;
    const name = nodeType(callee) === "Identifier"
      ? (typeof callee["name"] === "string" ? callee.name : undefined)
      : nodeType(callee) === "MemberExpression"
        ? propertyName(callee)
        : undefined;
    if (name === undefined) return;
    if (TOKEN_CALL_NAMES.has(name)) {
      found = true;
      return;
    }
    if (depth >= 1) return;
    const resolved = functions.get(name)?.[0];
    if (resolved !== undefined && jsHasTokenAssignment(resolved, functions, depth + 1)) {
      found = true;
    }
  });
  return found;
}

function analyzeJsFiles(files: ReadonlyMap<string, string>): OAuthFlowAnalysis {
  const findings: OAuthCallbackFinding[] = [];
  const limitations: string[] = [];
  let candidatesExamined = 0;

  for (const [path, source] of files) {
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
      limitations.push(`${path}: OAuth flow source could not be parsed.`);
      continue;
    }
    const root = isObject(ast) ? ast : undefined;
    if (root === undefined) {
      limitations.push(`${path}: OAuth flow source could not be parsed.`);
      continue;
    }

    const functions = collectJsFunctions(root);
    walk(root, (node) => {
      if (nodeType(node) !== "CallExpression") return;
      const callee = isObject(node["callee"]) ? node["callee"] : undefined;
      if (callee === undefined || nodeType(callee) !== "MemberExpression") return;
      const method = propertyName(callee)?.toLowerCase();
      if (method === undefined || !["get", "post", "put", "patch", "delete", "all", "use", "route"].includes(method)) {
        return;
      }
      const args = Array.isArray(node["arguments"]) ? node["arguments"] : [];
      const routePath = literalValue(args[0]);
      if (routePath === undefined || !routePath.toLowerCase().includes("callback")) return;

      candidatesExamined += 1;
      const handler = resolveJsHandler(args[1], functions);
      if (handler === undefined) {
        limitations.push(`${path}:${safeLocation(node).line ?? 0}: OAuth callback route "${routePath}" handler could not be resolved statically.`);
        return;
      }

      const sessionId = hasQueryParam(handler, "session_id") || hasQueryParam(handler, "sessionId");
      const state = hasQueryParam(handler, "state");
      const token = jsHasTokenAssignment(handler, functions);
      const cookie = hasIdentifierOrString(handler, COOKIE_NAMES);
      const stateName = hasIdentifierOrString(handler, STATE_NAMES);
      const hasBrowserBoundState = cookie && stateName;

      if ((sessionId || state) && token && !hasBrowserBoundState) {
        const location = safeLocation(handler);
        findings.push({
          path,
          ...location,
          identity: `oauth-callback:${path}:${location.line ?? 0}:${location.column ?? 0}`,
          detail: `OAuth callback route "${routePath}" reads a query-string ${sessionId ? "session" : "state"} identifier and assigns a token without a browser-bound state cookie.`,
        });
      }
    });
  }

  return {
    findings: dedupeFindings(findings),
    limitations: [...new Set(limitations)].sort(),
    candidatesExamined,
  };
}

interface GoFunction {
  readonly path: string;
  readonly name: string;
  readonly line?: number;
  readonly column?: number;
  readonly body: readonly GoToken[];
}

interface GoRoute {
  readonly path: string;
  readonly routePath: string;
  readonly handlerName?: string;
  readonly line?: number;
  readonly column?: number;
}

const GO_ROUTE_METHODS = new Set(["HandleFunc", "Handle", "Get", "Post", "Put", "Delete", "Patch", "Route", "All"]);

function nextNonNewline(tokens: readonly GoToken[], start: number): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.kind !== "newline") return index;
  }
  return undefined;
}

function findMatching(tokens: readonly GoToken[], start: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "op") continue;
    if (token.value === open) depth += 1;
    else if (token.value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function collectGoFunctions(path: string, tokens: readonly GoToken[]): GoFunction[] {
  const functions: GoFunction[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.kind !== "name" || tokens[index]?.value !== "func") continue;
    let cursor = nextNonNewline(tokens, index + 1);
    if (cursor === undefined) continue;
    if (tokens[cursor]?.kind === "op" && tokens[cursor]?.value === "(") {
      const receiverEnd = findMatching(tokens, cursor, "(", ")");
      if (receiverEnd === undefined) continue;
      cursor = nextNonNewline(tokens, receiverEnd + 1);
      if (cursor === undefined) continue;
    }
    const nameToken = tokens[cursor];
    if (nameToken?.kind !== "name") continue;

    let open = cursor + 1;
    let parenDepth = 0;
    let bracketDepth = 0;
    for (; open < tokens.length; open += 1) {
      const token = tokens[open];
      if (token?.kind !== "op") continue;
      if (token.value === "(") parenDepth += 1;
      else if (token.value === ")") parenDepth -= 1;
      else if (token.value === "[") bracketDepth += 1;
      else if (token.value === "]") bracketDepth -= 1;
      else if (token.value === "{" && parenDepth === 0 && bracketDepth === 0) break;
      else if (token.value === ";" && parenDepth === 0) break;
    }
    if (tokens[open]?.value !== "{") continue;
    const close = findMatching(tokens, open, "{", "}");
    if (close === undefined) continue;
    functions.push({
      path,
      name: nameToken.value,
      ...(nameToken.line === undefined ? {} : { line: nameToken.line }),
      ...(nameToken.column === undefined ? {} : { column: nameToken.column }),
      body: tokens.slice(open + 1, close),
    });
    index = close;
  }
  return functions;
}

function collectGoRoutes(path: string, tokens: readonly GoToken[], functionNames: ReadonlySet<string>): GoRoute[] {
  const routes: GoRoute[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "name" || !GO_ROUTE_METHODS.has(token.value)) continue;
    const open = nextNonNewline(tokens, index + 1);
    if (open === undefined || tokens[open]?.kind !== "op" || tokens[open]?.value !== "(") continue;
    const close = findMatching(tokens, open, "(", ")");
    if (close === undefined) continue;
    const inner = tokens.slice(open + 1, close);
    const routeToken = inner.find((entry) => entry.kind === "string");
    if (routeToken === undefined || !routeToken.value.toLowerCase().includes("callback")) continue;
    const handlerNames = inner
      .filter((entry) => entry.kind === "name" && functionNames.has(entry.value))
      .map((entry) => entry.value);
    const handlerName = handlerNames[handlerNames.length - 1];
    routes.push({
      path,
      routePath: routeToken.value,
      ...(handlerName === undefined ? {} : { handlerName }),
      line: routeToken.line,
      column: routeToken.column,
    });
    index = close;
  }
  return routes;
}

function hasGoSessionIdQuery(tokens: readonly GoToken[]): boolean {
  const hasSessionString = tokens.some((token) =>
    token.kind === "string" && (token.value === "session_id" || token.value === "sessionId")
  );
  const hasQueryRead = tokens.some((token) =>
    token.kind === "name" && (token.value === "Query" || token.value === "FormValue")
  );
  return hasSessionString && hasQueryRead;
}

function hasGoTokenAssignment(tokens: readonly GoToken[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "name") continue;
    if (token.value === "SetAccessToken" || token.value === "setAccessToken") return true;
    if (token.value !== "AccessToken") continue;
    const cursor = nextNonNewline(tokens, index + 1);
    if (cursor !== undefined && tokens[cursor]?.kind === "op" && tokens[cursor]?.value === "=") return true;
  }
  return false;
}

function hasGoStateDefense(tokens: readonly GoToken[]): boolean {
  const hasCookie = tokens.some((token) =>
    token.kind === "name" &&
    (token.value === "SetCookie" ||
      token.value === "Cookie" ||
      token.value === "cookie" ||
      token.value.endsWith("Cookie") ||
      token.value.endsWith("cookie"))
  );
  if (!hasCookie) return false;
  return tokens.some((token) =>
    token.kind === "name"
      ? ["state", "State", "oauth_state", "csrf"].includes(token.value)
      : token.kind === "string" && ["state", "oauth_state", "csrf"].includes(token.value)
  );
}

function collectGoCallees(
  handler: GoFunction,
  functions: ReadonlyMap<string, GoFunction[]>,
): GoFunction[] {
  const callees: GoFunction[] = [];
  for (let index = 0; index < handler.body.length; index += 1) {
    const token = handler.body[index];
    if (token?.kind !== "name") continue;
    const next = nextNonNewline(handler.body, index + 1);
    if (next === undefined || handler.body[next]?.kind !== "op" || handler.body[next]?.value !== "(") continue;
    for (const resolved of functions.get(token.value) ?? []) {
      if (resolved === handler) continue;
      callees.push(resolved);
    }
  }
  return callees;
}

function analyzeGoFiles(files: ReadonlyMap<string, string>): OAuthFlowAnalysis {
  const findings: OAuthCallbackFinding[] = [];
  const limitations: string[] = [];
  const functions = new Map<string, GoFunction[]>();
  const tokensByPath = new Map<string, readonly GoToken[]>();
  const routes: GoRoute[] = [];
  let candidatesExamined = 0;

  // First pass: index every function so a callback route in one file can
  // resolve a handler defined in another file.
  for (const [path, source] of files) {
    const tokens = tokenizeGo(source);
    if (tokens === undefined) {
      limitations.push(`${path}: Go OAuth flow source could not be tokenized.`);
      continue;
    }
    tokensByPath.set(path, tokens);
    for (const fn of collectGoFunctions(path, tokens)) {
      const existing = functions.get(fn.name) ?? [];
      existing.push(fn);
      functions.set(fn.name, existing);
    }
  }

  // Second pass: resolve routes against the complete function index.
  const functionNames = new Set(functions.keys());
  for (const [path, tokens] of tokensByPath) {
    routes.push(...collectGoRoutes(path, tokens, functionNames));
  }

  for (const route of routes) {
    candidatesExamined += 1;
    const handlers = route.handlerName === undefined ? [] : functions.get(route.handlerName) ?? [];
    if (handlers.length === 0) {
      limitations.push(`${route.path}:${route.line ?? 0}: OAuth callback route "${route.routePath}" handler could not be resolved statically.`);
      continue;
    }
    for (const handler of handlers) {
      const callees = collectGoCallees(handler, functions);
      const bodies = [handler, ...callees];
      const sessionId = bodies.some((body) => hasGoSessionIdQuery(body.body));
      const token = bodies.some((body) => hasGoTokenAssignment(body.body));
      const defended = bodies.some((body) => hasGoStateDefense(body.body));
      if (!sessionId || !token || defended) continue;

      const queryBodies = bodies.filter((body) =>
        body.body.some((entry) =>
          entry.kind === "name" && (entry.value === "Query" || entry.value === "FormValue")
        )
      );
      const sessionToken = (queryBodies.length > 0 ? queryBodies : bodies)
        .flatMap((body) => body.body.map((entry) => ({ body, entry })))
        .find(({ entry }) => entry.kind === "string" && (entry.value === "session_id" || entry.value === "sessionId"));
      const locationPath = sessionToken?.body.path ?? handler.path;
      const location = sessionToken?.entry;
      findings.push({
        path: locationPath,
        ...(location === undefined ? {} : { line: location.line, column: location.column }),
        identity: `oauth-callback:${route.path}:${route.line ?? 0}:${route.column ?? 0}:${handler.name}`,
        detail: `OAuth callback route "${route.routePath}" reads a query-string session identifier in ${sessionToken?.body.name ?? handler.name} and assigns a token without a browser-bound state cookie.`,
      });
    }
  }

  return {
    findings: dedupeFindings(findings),
    limitations: [...new Set(limitations)].sort(),
    candidatesExamined,
  };
}

function dedupeFindings(findings: readonly OAuthCallbackFinding[]): OAuthCallbackFinding[] {
  const seen = new Set<string>();
  const result: OAuthCallbackFinding[] = [];
  for (const finding of findings) {
    if (seen.has(finding.identity)) continue;
    seen.add(finding.identity);
    result.push(finding);
  }
  return result.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0)
  );
}

export function analyzeOAuthFlows(
  jsFiles: ReadonlyMap<string, string>,
  goFiles: ReadonlyMap<string, string>,
): OAuthFlowAnalysis {
  const js = analyzeJsFiles(jsFiles);
  const go = analyzeGoFiles(goFiles);
  return {
    findings: dedupeFindings([...js.findings, ...go.findings]),
    limitations: [...new Set([...js.limitations, ...go.limitations])].sort(),
    candidatesExamined: js.candidatesExamined + go.candidatesExamined,
  };
}
