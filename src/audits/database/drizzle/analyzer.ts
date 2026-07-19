import { parse, type ParserPlugin } from "@babel/parser";
import { posix } from "node:path";
import type {
  DrizzleAnalysisLimitation,
  DrizzleAnalyzerBounds,
  DrizzleDateEvidenceClass,
  DrizzleDateMatch,
  DrizzleRawSqlDateAnalysis,
} from "./types.js";

type Node = Record<string, unknown>;

interface Binding {
  readonly name: string;
  readonly kind:
    | "import-sql"
    | "import-drizzle"
    | "import-schema"
    | "import-other"
    | "const"
    | "local"
    | "parameter";
  readonly importedName?: string;
  readonly declarationOffset: number;
  readonly init?: Node;
  readonly exactDateType: boolean;
  readonly writes: number[];
  duplicate: boolean;
}

interface Scope {
  readonly parent?: Scope;
  readonly bindings: Map<string, Binding>;
}

interface Bounds {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxLimitations: number;
  readonly maxMatches: number;
}

interface BindingDiscoveryBudget {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly visited: WeakSet<object>;
  nodes: number;
  exceeded: boolean;
}

interface PendingInterpolation {
  readonly expression: Node;
  readonly scope: Scope;
  readonly sqlBinding: string;
}

const DEFAULT_BOUNDS: Bounds = {
  maxNodes: 100_000,
  maxDepth: 256,
  maxLimitations: 64,
  maxMatches: 10_000,
};
const DATE_PROOF_MAX_DEPTH = 64;

const structuralSqlCalls = new Set([
  "and", "asc", "between", "desc", "eq", "exists", "gt", "gte", "ilike",
  "inArray", "isNotNull", "isNull", "like", "lt", "lte", "ne", "not",
  "notBetween", "notExists", "notIlike", "notInArray", "notLike", "or",
]);

function objectNode(value: unknown): Node | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Node
    : undefined;
}

function nodeType(node: Node | undefined): string | undefined {
  return typeof node?.type === "string" ? node.type : undefined;
}

function identifierName(node: Node | undefined): string | undefined {
  return nodeType(node) === "Identifier" && typeof node?.name === "string"
    ? node.name
    : undefined;
}

function offset(node: Node | undefined): number {
  return typeof node?.start === "number" ? node.start : Number.MAX_SAFE_INTEGER;
}

function location(node: Node): { line: number; column: number } | undefined {
  const loc = objectNode(node.loc);
  const start = objectNode(loc?.start);
  if (typeof start?.line !== "number" || typeof start.column !== "number") return undefined;
  return { line: start.line, column: start.column + 1 };
}

function parserPlugins(path: string): ParserPlugin[] {
  const extension = posix.extname(path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  if ([".jsx", ".tsx"].includes(extension)) plugins.push("jsx");
  plugins.push("decorators-legacy");
  return plugins;
}

export interface DrizzlePostgresJsAdapterImportAnalysis {
  readonly status: "completed" | "partial";
  readonly present: boolean;
}

/**
 * Proves only a runtime static import of the exact postgres-js adapter module.
 * This deliberately does not use text search, subpath inference, or type-only
 * imports as execution-path evidence.
 */
export function analyzeDrizzlePostgresJsAdapterImport(
  path: string,
  source: string,
): DrizzlePostgresJsAdapterImportAnalysis {
  let ast: unknown;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: path,
      plugins: parserPlugins(path),
      attachComment: false,
      errorRecovery: false,
      createImportExpressions: true,
    });
  } catch {
    return { status: "partial", present: false };
  }
  const program = objectNode(objectNode(ast)?.program);
  for (const rawStatement of Array.isArray(program?.body) ? program.body : []) {
    const statement = objectNode(rawStatement);
    if (statement === undefined || nodeType(statement) !== "ImportDeclaration" ||
        statement.importKind === "type") continue;
    if (objectNode(statement.source)?.value !== "drizzle-orm/postgres-js") continue;
    const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers : [];
    if (specifiers.length === 0 || specifiers.some((rawSpecifier) =>
      objectNode(rawSpecifier)?.importKind !== "type"
    )) {
      return { status: "completed", present: true };
    }
  }
  return { status: "completed", present: false };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function normalizeBounds(options: DrizzleAnalyzerBounds): Bounds {
  return {
    maxNodes: boundedInteger(options.maxNodes, DEFAULT_BOUNDS.maxNodes, 1),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_BOUNDS.maxDepth, 1),
    maxLimitations: boundedInteger(options.maxLimitations, DEFAULT_BOUNDS.maxLimitations, 1),
    maxMatches: boundedInteger(options.maxMatches, DEFAULT_BOUNDS.maxMatches, 1),
  };
}

function resolve(scope: Scope, name: string): Binding | undefined {
  let current: Scope | undefined = scope;
  while (current !== undefined) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
    current = current.parent;
  }
  return undefined;
}

function exactDateType(annotationContainer: Node | undefined): boolean {
  let annotation = objectNode(annotationContainer?.typeAnnotation) ?? annotationContainer;
  if (nodeType(annotation) === "TSTypeAnnotation") annotation = objectNode(annotation?.typeAnnotation);
  return nodeType(annotation) === "TSTypeReference" &&
    identifierName(objectNode(annotation?.typeName)) === "Date";
}

function exactRequiredDateBinding(pattern: Node | undefined): boolean {
  let candidate = pattern;
  if (nodeType(candidate) === "TSParameterProperty") candidate = objectNode(candidate?.parameter);
  if (nodeType(candidate) !== "Identifier" || candidate?.optional === true) return false;
  return exactDateType(candidate);
}

function enterBindingDiscovery(
  node: Node | undefined,
  budget: BindingDiscoveryBudget,
  depth: number,
): node is Node {
  if (node === undefined || budget.visited.has(node)) return false;
  if (depth > budget.maxDepth || budget.nodes >= budget.maxNodes) {
    budget.exceeded = true;
    return false;
  }
  budget.visited.add(node);
  budget.nodes += 1;
  return true;
}

function bindingNames(
  pattern: Node | undefined,
  budget: BindingDiscoveryBudget,
  depth: number,
  initializers?: Node[],
): string[] {
  if (!enterBindingDiscovery(pattern, budget, depth)) return [];
  const name = identifierName(pattern);
  if (name !== undefined) return [name];
  const type = nodeType(pattern);
  if (type === "RestElement") {
    return bindingNames(objectNode(pattern.argument), budget, depth + 1, initializers);
  }
  if (type === "TSParameterProperty") {
    return bindingNames(objectNode(pattern.parameter), budget, depth + 1, initializers);
  }
  if (type === "AssignmentPattern") {
    const initializer = objectNode(pattern.right);
    if (initializer !== undefined) initializers?.push(initializer);
    return bindingNames(objectNode(pattern.left), budget, depth + 1, initializers);
  }
  if (type === "ObjectPattern" || type === "ArrayPattern") {
    const values = type === "ObjectPattern" ? pattern.properties : pattern.elements;
    if (!Array.isArray(values)) return [];
    const names: string[] = [];
    for (const entry of values) {
      if (budget.exceeded) break;
      const node = objectNode(entry);
      if (nodeType(node) === "ObjectProperty") {
        if (!enterBindingDiscovery(node, budget, depth + 1)) continue;
        names.push(...bindingNames(objectNode(node.value), budget, depth + 2, initializers));
      } else {
        names.push(...bindingNames(node, budget, depth + 1, initializers));
      }
    }
    return names;
  }
  return [];
}

function declare(scope: Scope, binding: Binding): void {
  const existing = scope.bindings.get(binding.name);
  if (existing !== undefined) {
    existing.duplicate = true;
    binding.duplicate = true;
  }
  scope.bindings.set(binding.name, binding);
}

function predeclareStatement(
  scope: Scope,
  statement: Node,
  budget: BindingDiscoveryBudget,
  depth: number,
): void {
  if (!enterBindingDiscovery(statement, budget, depth)) return;
  const type = nodeType(statement);
  if (type === "ImportDeclaration") {
    const source = objectNode(statement.source);
    const fromDrizzle = source?.value === "drizzle-orm";
    const fromSchema = typeof source?.value === "string" &&
      /(?:^|[/.-])schema(?:[/.-]|$)/i.test(source.value);
    if (!Array.isArray(statement.specifiers)) return;
    for (const rawSpecifier of statement.specifiers) {
      if (budget.exceeded) break;
      const specifier = objectNode(rawSpecifier);
      if (!enterBindingDiscovery(specifier, budget, depth + 1)) continue;
      const local = identifierName(objectNode(specifier?.local));
      if (local === undefined) continue;
      const imported = identifierName(objectNode(specifier?.imported));
      const importedSql = fromDrizzle && nodeType(specifier) === "ImportSpecifier" &&
        imported === "sql" && specifier?.importKind !== "type" && statement.importKind !== "type";
      declare(scope, {
        name: local,
        kind: importedSql
          ? "import-sql"
          : fromDrizzle ? "import-drizzle" : fromSchema ? "import-schema" : "import-other",
        ...(imported === undefined ? {} : { importedName: imported }),
        declarationOffset: offset(specifier),
        exactDateType: false,
        writes: [],
        duplicate: false,
      });
    }
    return;
  }
  if (type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
    if (statement.kind === "var") return;
    for (const rawDeclaration of statement.declarations) {
      if (budget.exceeded) break;
      const declaration = objectNode(rawDeclaration);
      if (!enterBindingDiscovery(declaration, budget, depth + 1)) continue;
      const id = objectNode(declaration?.id);
      const init = objectNode(declaration?.init);
      for (const name of bindingNames(id, budget, depth + 2)) {
        declare(scope, {
          name,
          kind: statement.kind === "const" ? "const" : "local",
          declarationOffset: offset(declaration),
          ...(identifierName(id) === name && init !== undefined ? { init } : {}),
          exactDateType: identifierName(id) === name && exactRequiredDateBinding(id),
          writes: [],
          duplicate: false,
        });
      }
    }
    return;
  }
  if (type === "FunctionDeclaration" || type === "ClassDeclaration") {
    const name = identifierName(objectNode(statement.id));
    if (name !== undefined) {
      declare(scope, {
        name,
        kind: "local",
        declarationOffset: offset(statement),
        exactDateType: false,
        writes: [],
        duplicate: false,
      });
    }
    return;
  }
  if (type === "TSTypeAliasDeclaration" || type === "TSInterfaceDeclaration") {
    const name = identifierName(objectNode(statement.id));
    if (name !== undefined) {
      declare(scope, {
        name,
        kind: "local",
        declarationOffset: offset(statement),
        exactDateType: false,
        writes: [],
        duplicate: false,
      });
    }
  }
}

function predeclareHoistedVars(
  scope: Scope,
  body: unknown,
  parentBudget: BindingDiscoveryBudget,
  depth: number,
): void {
  const remainingNodes = Math.max(1, parentBudget.maxNodes - parentBudget.nodes);
  const budget: BindingDiscoveryBudget = {
    maxNodes: remainingNodes,
    maxDepth: parentBudget.maxDepth,
    visited: new WeakSet(),
    nodes: 0,
    exceeded: false,
  };

  const scan = (value: unknown, currentDepth: number): void => {
    if (budget.exceeded) return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child, currentDepth + 1);
      return;
    }
    const node = objectNode(value);
    if (!enterBindingDiscovery(node, budget, currentDepth)) return;
    const type = nodeType(node);
    if ([
      "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
      "ObjectMethod", "ClassMethod", "ClassPrivateMethod", "ClassDeclaration",
      "ClassExpression", "StaticBlock",
    ].includes(type ?? "")) return;

    if (type === "VariableDeclaration" && node.kind === "var" && Array.isArray(node.declarations)) {
      for (const rawDeclaration of node.declarations) {
        const declaration = objectNode(rawDeclaration);
        if (declaration === undefined) continue;
        const id = objectNode(declaration.id);
        const init = objectNode(declaration.init);
        for (const name of bindingNames(id, budget, currentDepth + 1)) {
          declare(scope, {
            name,
            kind: "local",
            declarationOffset: offset(declaration),
            ...(identifierName(id) === name && init !== undefined ? { init } : {}),
            exactDateType: identifierName(id) === name && exactRequiredDateBinding(id),
            writes: [],
            duplicate: false,
          });
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) scan(child, currentDepth + 1);
    }
  };

  scan(body, depth);
  parentBudget.nodes += budget.nodes;
  if (budget.exceeded || parentBudget.nodes > parentBudget.maxNodes) parentBudget.exceeded = true;
}

function predeclareBody(
  scope: Scope,
  body: unknown,
  budget: BindingDiscoveryBudget,
  depth: number,
): void {
  if (!Array.isArray(body)) return;
  for (const rawStatement of body) {
    if (budget.exceeded) break;
    const statement = objectNode(rawStatement);
    if (statement !== undefined) predeclareStatement(scope, statement, budget, depth + 1);
  }
}

function addParameters(
  scope: Scope,
  params: unknown,
  budget: BindingDiscoveryBudget,
  depth: number,
): Node[] {
  const initializers: Node[] = [];
  if (!Array.isArray(params)) return initializers;
  for (const rawParam of params) {
    if (budget.exceeded) break;
    const param = objectNode(rawParam);
    for (const name of bindingNames(param, budget, depth + 1, initializers)) {
      declare(scope, {
        name,
        kind: "parameter",
        declarationOffset: offset(param),
        exactDateType: (identifierName(param) === name || nodeType(param) === "TSParameterProperty") &&
          exactRequiredDateBinding(param),
        writes: [],
        duplicate: false,
      });
    }
  }
  return initializers;
}

function isGlobalDate(scope: Scope, callee: Node | undefined): boolean {
  const name = identifierName(callee);
  return name === "Date" && resolve(scope, name) === undefined;
}

function isDateAssertion(node: Node, scope: Scope): boolean {
  const type = nodeType(node);
  return (type === "TSAsExpression" || type === "TSTypeAssertion") &&
    exactDateType(objectNode(node.typeAnnotation)) && resolve(scope, "Date") === undefined;
}

function writeBefore(binding: Binding, useOffset: number): boolean {
  return binding.writes.some((write) => write < useOffset);
}

function proveDate(
  expression: Node,
  scope: Scope,
  useOffset: number,
  seen: Set<Binding> = new Set(),
  remainingDepth = DATE_PROOF_MAX_DEPTH,
): DrizzleDateEvidenceClass | undefined {
  if (remainingDepth <= 0) return undefined;
  if (isDateAssertion(expression, scope)) return "date-type-assertion";
  if (nodeType(expression) === "NewExpression" && isGlobalDate(scope, objectNode(expression.callee))) {
    return "direct-date-construction";
  }
  const name = identifierName(expression);
  if (name === undefined) return undefined;
  const binding = resolve(scope, name);
  if (binding === undefined || binding.duplicate || binding.declarationOffset >= useOffset ||
      binding.writes.length > 0 || writeBefore(binding, useOffset)) return undefined;
  if (binding.exactDateType && resolve(scope, "Date") === undefined) return "declared-date-type";
  if (binding.kind !== "const" || binding.init === undefined || binding.writes.length > 0 || seen.has(binding)) {
    return undefined;
  }
  seen.add(binding);
  return proveDate(binding.init, scope, binding.declarationOffset, seen, remainingDepth - 1) === undefined
    ? undefined
    : "immutable-date-binding";
}

function importedSqlBinding(scope: Scope, identifier: Node | undefined): boolean {
  const name = identifierName(identifier);
  return name !== undefined && resolve(scope, name)?.kind === "import-sql";
}

type SqlParameterClassification =
  | { readonly kind: "not-parameter" }
  | { readonly kind: "safe" }
  | { readonly kind: "invalid"; readonly value?: Node }
  | { readonly kind: "unknown" };

function isCallableNode(node: Node | undefined): boolean {
  return ["ArrowFunctionExpression", "FunctionExpression", "ObjectMethod"].includes(nodeType(node) ?? "");
}

function isFreshInlineEncoder(object: Node): boolean {
  if (nodeType(object) !== "ObjectExpression" || !Array.isArray(object.properties)) return false;
  if (object.properties.some((property) => nodeType(objectNode(property)) === "SpreadElement")) return false;
  let mapProperty: Node | undefined;
  for (const rawProperty of object.properties) {
    const property = objectNode(rawProperty);
    if (property === undefined || property.computed === true) continue;
    if (identifierName(objectNode(property.key)) === "mapToDriverValue" ||
        (nodeType(objectNode(property.key)) === "StringLiteral" &&
          objectNode(property.key)?.value === "mapToDriverValue")) {
      mapProperty = property;
    }
  }
  if (nodeType(mapProperty) === "ObjectMethod") return mapProperty?.kind === "method";
  return nodeType(mapProperty) === "ObjectProperty" && isCallableNode(objectNode(mapProperty?.value));
}

function definitelyInvalidEncoder(expression: Node | undefined, scope: Scope): boolean {
  if (expression === undefined) return true;
  const type = nodeType(expression);
  if (type === "Identifier" && identifierName(expression) === "undefined" &&
      resolve(scope, "undefined") === undefined) return true;
  if (type === "NullLiteral" || (type === "UnaryExpression" && expression.operator === "void")) return true;
  return [
    "StringLiteral", "NumericLiteral", "BooleanLiteral", "BigIntLiteral", "RegExpLiteral",
  ].includes(type ?? "") ||
    (type === "TemplateLiteral" && Array.isArray(expression.expressions) && expression.expressions.length === 0) ||
    type === "ArrayExpression";
}

function classifySqlParameter(
  expression: Node,
  scope: Scope,
): SqlParameterClassification {
  if (nodeType(expression) !== "CallExpression") return { kind: "not-parameter" };
  const callee = objectNode(expression.callee);
  if (callee === undefined || nodeType(callee) !== "MemberExpression" || callee.computed === true ||
      !importedSqlBinding(scope, objectNode(callee.object)) ||
      identifierName(objectNode(callee.property)) !== "param") {
    return { kind: "not-parameter" };
  }
  const args = Array.isArray(expression.arguments) ? expression.arguments : [];
  const value = objectNode(args[0]);
  const encoder = objectNode(args[1]);
  if (args.length < 2 || definitelyInvalidEncoder(encoder, scope)) {
    return { kind: "invalid", ...(value === undefined ? {} : { value }) };
  }
  // An object held in any binding can be mutated through an alias without a
  // write to that binding. Only a fresh inline object is locally provable.
  if (args.length === 2 && encoder !== undefined && isFreshInlineEncoder(encoder)) {
    return { kind: "safe" };
  }
  return { kind: "unknown" };
}

function isLiteralOrKnownScalar(
  expression: Node,
  scope: Scope,
  useOffset: number,
  seen: Set<Binding> = new Set(),
  remainingDepth = 64,
): boolean {
  if (remainingDepth <= 0) return false;
  const type = nodeType(expression);
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "BigIntLiteral"].includes(type ?? "")) {
    return true;
  }
  if (type === "TemplateLiteral" && Array.isArray(expression.expressions) && expression.expressions.length === 0) {
    return true;
  }
  if (type === "CallExpression") {
    const callee = objectNode(expression.callee);
    if (identifierName(callee) === "Date" && isGlobalDate(scope, callee)) return true;
    if (callee !== undefined && nodeType(callee) === "MemberExpression" && callee.computed !== true) {
      const object = objectNode(callee.object);
      const property = identifierName(objectNode(callee.property));
      if (identifierName(object) === "Date" && resolve(scope, "Date") === undefined && property === "now") return true;
      if (property === "toISOString") return true;
    }
  }
  const name = identifierName(expression);
  if (name === undefined) return false;
  const binding = resolve(scope, name);
  if (binding?.kind === "const" && binding.init !== undefined && !binding.duplicate &&
      binding.declarationOffset < useOffset && binding.writes.length === 0 &&
      !writeBefore(binding, useOffset) && !seen.has(binding)) {
    seen.add(binding);
    return isLiteralOrKnownScalar(
      binding.init,
      scope,
      binding.declarationOffset,
      seen,
      remainingDepth - 1,
    );
  }
  return false;
}

function tableFactoryBinding(binding: Binding | undefined, scope: Scope): boolean {
  const init = binding?.init;
  if (nodeType(init) !== "CallExpression") return false;
  const factory = identifierName(objectNode(init?.callee));
  if (factory === undefined) return false;
  const factoryBinding = resolve(scope, factory);
  return factoryBinding?.kind === "import-drizzle" &&
    /(?:pg|mysql|sqlite)?Table$/.test(factoryBinding.importedName ?? factory);
}

function structuralRootBinding(expression: Node, scope: Scope): Binding | undefined {
  let current: Node | undefined = expression;
  while (current !== undefined && nodeType(current) === "MemberExpression" && current.computed !== true) {
    current = objectNode(current.object);
  }
  const name = identifierName(current);
  return name === undefined ? undefined : resolve(scope, name);
}

// Conservative structural heuristic: only bindings tied to Drizzle, a schema
// module, or a recognized table factory are treated as SQL structure.
function isObviousSqlStructure(expression: Node, scope: Scope): boolean {
  if (nodeType(expression) === "MemberExpression" && expression.computed !== true) {
    const binding = structuralRootBinding(expression, scope);
    return binding?.kind === "import-drizzle" || binding?.kind === "import-schema" ||
      tableFactoryBinding(binding, scope);
  }
  const name = identifierName(expression);
  if (name !== undefined) {
    const binding = resolve(scope, name);
    if (binding?.kind === "import-drizzle" || binding?.kind === "import-schema") return true;
    if (tableFactoryBinding(binding, scope)) return true;
  }
  if (nodeType(expression) === "CallExpression") {
    const callee = objectNode(expression.callee);
    const calleeName = identifierName(callee);
    if (calleeName === undefined) return false;
    const binding = resolve(scope, calleeName);
    return binding?.kind === "import-drizzle" &&
      structuralSqlCalls.has(binding.importedName ?? calleeName);
  }
  return false;
}

function assignmentNames(
  node: Node,
  budget: BindingDiscoveryBudget,
  depth: number,
): string[] {
  const type = nodeType(node);
  if (type === "AssignmentExpression") return bindingNames(objectNode(node.left), budget, depth + 1);
  if (type === "UpdateExpression") return bindingNames(objectNode(node.argument), budget, depth + 1);
  return [];
}

function assignedMemberRootName(node: Node): string | undefined {
  const type = nodeType(node);
  let target: Node | undefined;
  if (type === "AssignmentExpression") target = objectNode(node.left);
  if (type === "UpdateExpression" || (type === "UnaryExpression" && node.operator === "delete")) {
    target = objectNode(node.argument);
  }
  if (nodeType(target) !== "MemberExpression") return undefined;
  while (nodeType(target) === "MemberExpression") target = objectNode(target?.object);
  return identifierName(target);
}

export function analyzeDrizzleRawSqlDates(
  path: string,
  source: string,
  options: DrizzleAnalyzerBounds = {},
): DrizzleRawSqlDateAnalysis {
  let ast: unknown;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: path,
      plugins: parserPlugins(path),
      attachComment: false,
      errorRecovery: false,
      createImportExpressions: true,
    });
  } catch {
    return { status: "partial", matches: [], limitations: [{ code: "parse-failure" }] };
  }

  const bounds = normalizeBounds(options);
  const matches: Array<DrizzleDateMatch & { offset: number }> = [];
  const limitations: Array<DrizzleAnalysisLimitation & { offset?: number }> = [];
  const pendingInterpolations: PendingInterpolation[] = [];
  const visited = new WeakSet<object>();
  const bindingBudget: BindingDiscoveryBudget = {
    maxNodes: bounds.maxNodes,
    maxDepth: bounds.maxDepth,
    visited: new WeakSet(),
    nodes: 0,
    exceeded: false,
  };
  let nodes = 0;
  let budgetExceeded = false;
  let matchLimitExceeded = false;

  const addLimitation = (limitation: DrizzleAnalysisLimitation, node?: Node): void => {
    if (limitations.length >= bounds.maxLimitations) return;
    limitations.push({ ...limitation, ...(node === undefined ? {} : { offset: offset(node) }) });
  };

  const exceedBudget = (): void => {
    if (budgetExceeded) return;
    budgetExceeded = true;
    addLimitation({ code: "analysis-budget-exceeded" });
  };

  const rootScope: Scope = { bindings: new Map() };
  const program = objectNode(objectNode(ast)?.program);
  predeclareBody(rootScope, program?.body, bindingBudget, 0);
  predeclareHoistedVars(rootScope, program?.body, bindingBudget, 0);
  if (bindingBudget.exceeded) exceedBudget();

  const visit = (value: unknown, scope: Scope, depth: number): void => {
    if (budgetExceeded) return;
    if (depth > bounds.maxDepth) {
      exceedBudget();
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, scope, depth + 1);
      return;
    }
    const node = objectNode(value);
    if (node === undefined || visited.has(node)) return;
    visited.add(node);
    nodes += 1;
    if (nodes > bounds.maxNodes) {
      exceedBudget();
      return;
    }

    const type = nodeType(node);
    for (const name of assignmentNames(node, bindingBudget, depth)) {
      const binding = resolve(scope, name);
      if (binding !== undefined) binding.writes.push(offset(node));
    }
    const mutatedRoot = assignedMemberRootName(node);
    if (mutatedRoot !== undefined) {
      const binding = resolve(scope, mutatedRoot);
      if (binding !== undefined) binding.writes.push(offset(node));
    }
    if (bindingBudget.exceeded) {
      exceedBudget();
      return;
    }

    if (type === "Program") {
      for (const statement of Array.isArray(node.body) ? node.body : []) visit(statement, scope, depth + 1);
      return;
    }

    if (type === "BlockStatement") {
      const block: Scope = { parent: scope, bindings: new Map() };
      predeclareBody(block, node.body, bindingBudget, depth);
      if (bindingBudget.exceeded) {
        exceedBudget();
        return;
      }
      for (const statement of Array.isArray(node.body) ? node.body : []) visit(statement, block, depth + 1);
      return;
    }

    if (type === "ClassExpression" || type === "ClassDeclaration") {
      const classScope: Scope = { parent: scope, bindings: new Map() };
      const className = identifierName(objectNode(node.id));
      if (className !== undefined) {
        declare(classScope, {
          name: className,
          kind: "local",
          declarationOffset: offset(node),
          exactDateType: false,
          writes: [],
          duplicate: false,
        });
      }
      // A named class binding is active while its heritage and body are
      // evaluated. Methods and static blocks create their own child scopes.
      visit(node.superClass, classScope, depth + 1);
      visit(node.body, classScope, depth + 1);
      return;
    }

    if ([
      "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
      "ObjectMethod", "ClassMethod", "ClassPrivateMethod",
    ].includes(type ?? "")) {
      if (["ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(type ?? "") &&
          node.computed === true) {
        visit(node.key, scope, depth + 1);
        if (budgetExceeded) return;
      }
      const functionScope: Scope = { parent: scope, bindings: new Map() };
      const functionName = identifierName(objectNode(node.id));
      if (functionName !== undefined) {
        declare(functionScope, {
          name: functionName,
          kind: "local",
          declarationOffset: offset(node),
          exactDateType: false,
          writes: [],
          duplicate: false,
        });
      }
      const parameterInitializers = addParameters(functionScope, node.params, bindingBudget, depth);
      if (bindingBudget.exceeded) {
        exceedBudget();
        return;
      }
      for (const initializer of parameterInitializers) {
        visit(initializer, functionScope, depth + 1);
        if (budgetExceeded) return;
      }
      const body = objectNode(node.body);
      if (nodeType(body) === "BlockStatement") {
        predeclareBody(functionScope, body?.body, bindingBudget, depth);
        predeclareHoistedVars(functionScope, body?.body, bindingBudget, depth);
        if (bindingBudget.exceeded) {
          exceedBudget();
          return;
        }
        for (const statement of Array.isArray(body?.body) ? body.body : []) {
          visit(statement, functionScope, depth + 1);
        }
      } else {
        visit(body, functionScope, depth + 1);
      }
      return;
    }

    if (type === "CatchClause") {
      const catchScope: Scope = { parent: scope, bindings: new Map() };
      const param = objectNode(node.param);
      for (const name of bindingNames(param, bindingBudget, depth + 1)) {
        declare(catchScope, {
          name,
          kind: "parameter",
          declarationOffset: offset(param),
          exactDateType: identifierName(param) === name && exactRequiredDateBinding(param),
          writes: [],
          duplicate: false,
        });
      }
      const body = objectNode(node.body);
      predeclareBody(catchScope, body?.body, bindingBudget, depth);
      if (bindingBudget.exceeded) {
        exceedBudget();
        return;
      }
      for (const statement of Array.isArray(body?.body) ? body.body : []) {
        visit(statement, catchScope, depth + 1);
      }
      return;
    }

    if (type === "SwitchStatement") {
      const switchScope: Scope = { parent: scope, bindings: new Map() };
      visit(node.discriminant, scope, depth + 1);
      const cases = Array.isArray(node.cases) ? node.cases : [];
      for (const rawCase of cases) {
        if (bindingBudget.exceeded) break;
        const caseNode = objectNode(rawCase);
        predeclareBody(switchScope, caseNode?.consequent, bindingBudget, depth);
      }
      if (bindingBudget.exceeded) {
        exceedBudget();
        return;
      }
      for (const rawCase of cases) {
        const caseNode = objectNode(rawCase);
        visit(caseNode?.test, switchScope, depth + 1);
        for (const statement of Array.isArray(caseNode?.consequent) ? caseNode.consequent : []) {
          visit(statement, switchScope, depth + 1);
        }
      }
      return;
    }

    if (type === "StaticBlock") {
      const staticScope: Scope = { parent: scope, bindings: new Map() };
      predeclareBody(staticScope, node.body, bindingBudget, depth);
      predeclareHoistedVars(staticScope, node.body, bindingBudget, depth);
      if (bindingBudget.exceeded) {
        exceedBudget();
        return;
      }
      for (const statement of Array.isArray(node.body) ? node.body : []) {
        visit(statement, staticScope, depth + 1);
      }
      return;
    }

    if (["ForStatement", "ForInStatement", "ForOfStatement"].includes(type ?? "")) {
      const loopScope: Scope = { parent: scope, bindings: new Map() };
      const declaration = objectNode(type === "ForStatement" ? node.init : node.left);
      if (declaration !== undefined && nodeType(declaration) === "VariableDeclaration") {
        predeclareStatement(loopScope, declaration, bindingBudget, depth + 1);
      } else if ((type === "ForInStatement" || type === "ForOfStatement") && declaration !== undefined) {
        for (const name of bindingNames(declaration, bindingBudget, depth + 1)) {
          const binding = resolve(scope, name);
          if (binding !== undefined) binding.writes.push(offset(node));
        }
      }
      if (bindingBudget.exceeded) {
        exceedBudget();
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
        if (typeof child === "object" && child !== null) visit(child, loopScope, depth + 1);
      }
      return;
    }

    if (type === "TaggedTemplateExpression" && importedSqlBinding(scope, objectNode(node.tag))) {
      const quasi = objectNode(node.quasi);
      const sqlBinding = identifierName(objectNode(node.tag));
      for (const rawExpression of Array.isArray(quasi?.expressions) ? quasi.expressions : []) {
        const expression = objectNode(rawExpression);
        if (expression === undefined || sqlBinding === undefined) continue;
        pendingInterpolations.push({ expression, scope, sqlBinding });
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) visit(child, scope, depth + 1);
    }
  };

  visit(program, rootScope, 0);
  if (!budgetExceeded) {
    for (const { expression, scope, sqlBinding } of pendingInterpolations) {
      const parameter = classifySqlParameter(expression, scope);
      if (parameter.kind === "safe") continue;
      const proofExpression = parameter.kind === "invalid" ? parameter.value : undefined;
      const evidenceClass = proveDate(proofExpression ?? expression, scope, offset(expression));
      const safeLocation = location(expression);
      if (evidenceClass !== undefined && safeLocation !== undefined) {
        if (matches.length < bounds.maxMatches) {
          matches.push({
            ...safeLocation,
            evidenceClass,
            sqlBinding: sqlBinding.length <= 128 ? sqlBinding : "alias-over-limit",
            offset: offset(expression),
          });
        } else if (!matchLimitExceeded) {
          matchLimitExceeded = true;
          addLimitation({ code: "match-limit-exceeded" });
        }
      } else if (!isLiteralOrKnownScalar(expression, scope, offset(expression)) &&
          !isObviousSqlStructure(expression, scope)) {
        addLimitation({ code: "unresolved-interpolation", ...safeLocation }, expression);
      }
    }
  }
  matches.sort((left, right) => left.offset - right.offset || left.evidenceClass.localeCompare(right.evidenceClass));
  limitations.sort((left, right) =>
    (left.offset ?? Number.MAX_SAFE_INTEGER) - (right.offset ?? Number.MAX_SAFE_INTEGER) ||
    left.code.localeCompare(right.code)
  );

  return {
    status: budgetExceeded || matchLimitExceeded ||
        limitations.some(({ code }) => code !== "unresolved-interpolation")
      ? "partial"
      : limitations.length > 0 ? "partial" : "completed",
    matches: matches.map(({ offset: _offset, ...match }) => match),
    limitations: limitations.map(({ offset: _offset, ...limitation }) => limitation),
  };
}
