import { parse, type ParserPlugin } from "@babel/parser";
import { posix } from "node:path";
import type { SourceImportKind } from "./types.js";

type JsonLikeObject = Record<string, unknown>;

export interface SafeImportReference {
  readonly kind: SourceImportKind;
  readonly line?: number;
  readonly column?: number;
}

export interface SourceImportParseResult {
  readonly status: "completed" | "partial";
  readonly imports: readonly SafeImportReference[];
  readonly dynamicBoundaryCount: number;
  readonly limitations: readonly string[];
}

const rawSpecifiers = new WeakMap<SafeImportReference, string>();
const sourceOffsets = new WeakMap<SafeImportReference, number>();

function objectValue(value: unknown): JsonLikeObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonLikeObject
    : undefined;
}

function nodeType(node: JsonLikeObject | undefined): string | undefined {
  return typeof node?.type === "string" ? node.type : undefined;
}

function literalValue(node: JsonLikeObject | undefined): string | undefined {
  if (nodeType(node) !== "StringLiteral" && nodeType(node) !== "Literal") return undefined;
  return typeof node?.value === "string" ? node.value : undefined;
}

function pluginsFor(path: string): ParserPlugin[] {
  const extension = posix.extname(path).toLowerCase();
  const plugins: ParserPlugin[] = [];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  if ([".jsx", ".tsx"].includes(extension)) plugins.push("jsx");
  plugins.push("decorators-legacy");
  return plugins;
}

function isTypeOnlyImport(node: JsonLikeObject): boolean {
  if (node.importKind === "type") return true;
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return false;
  return node.specifiers.every((specifier) => objectValue(specifier)?.importKind === "type");
}

function isTypeOnlyExport(node: JsonLikeObject): boolean {
  if (node.exportKind === "type") return true;
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return false;
  return node.specifiers.every((specifier) => objectValue(specifier)?.exportKind === "type");
}

function safeLocation(node: JsonLikeObject): Pick<SafeImportReference, "line" | "column"> {
  const loc = objectValue(node.loc);
  const start = objectValue(loc?.start);
  return {
    ...(typeof start?.line === "number" ? { line: start.line } : {}),
    ...(typeof start?.column === "number" ? { column: start.column + 1 } : {}),
  };
}

export function importSpecifier(reference: SafeImportReference): string | undefined {
  return rawSpecifiers.get(reference);
}

export function parseSourceImports(path: string, source: string): SourceImportParseResult {
  let ast: unknown;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: path,
      plugins: pluginsFor(path),
      attachComment: false,
      errorRecovery: false,
      createImportExpressions: true,
    });
  } catch {
    return {
      status: "partial",
      imports: [],
      dynamicBoundaryCount: 0,
      limitations: [`${path}: source syntax could not be parsed.`],
    };
  }

  const imports: SafeImportReference[] = [];
  const visited = new WeakSet<object>();
  let dynamicBoundaryCount = 0;

  const addImport = (
    kind: SourceImportKind,
    node: JsonLikeObject,
    sourceNode: JsonLikeObject | undefined,
  ): void => {
    const specifier = literalValue(sourceNode);
    if (specifier === undefined) {
      dynamicBoundaryCount += 1;
      return;
    }
    const reference: SafeImportReference = { kind, ...safeLocation(node) };
    rawSpecifiers.set(reference, specifier);
    sourceOffsets.set(reference, typeof node.start === "number" ? node.start : Number.MAX_SAFE_INTEGER);
    imports.push(reference);
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const node = objectValue(value);
    if (node === undefined || visited.has(node)) return;
    visited.add(node);

    const type = nodeType(node);
    if (type === "ImportDeclaration") {
      addImport(isTypeOnlyImport(node) ? "type-only" : "static", node, objectValue(node.source));
    } else if (type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") {
      const sourceNode = objectValue(node.source);
      if (sourceNode !== undefined) {
        addImport(isTypeOnlyExport(node) ? "type-only" : "re-export", node, sourceNode);
      }
    } else if (type === "ImportExpression") {
      addImport("dynamic-literal", node, objectValue(node.source));
    } else if (type === "CallExpression") {
      const callee = objectValue(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (nodeType(callee) === "Identifier" && callee?.name === "require") {
        addImport("require", node, objectValue(args[0]));
      } else if (nodeType(callee) === "Import") {
        addImport("dynamic-literal", node, objectValue(args[0]));
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "errors", "tokens"].includes(key)) continue;
      if (typeof child === "object" && child !== null) visit(child);
    }
  };

  visit(ast);
  imports.sort((left, right) =>
    (sourceOffsets.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOffsets.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.kind.localeCompare(right.kind)
  );
  return {
    status: "completed",
    imports,
    dynamicBoundaryCount,
    limitations: [],
  };
}
