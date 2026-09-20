import {
  createImportReference,
  importSourceOffset,
  type SafeImportReference,
} from "./references.js";

export interface JavaImportParseResult {
  readonly status: "completed" | "partial";
  readonly packageName?: string;
  readonly imports: readonly SafeImportReference[];
  readonly dynamicBoundaryCount: number;
  readonly limitations: readonly string[];
}

interface Token {
  readonly kind: "name" | "string" | "op";
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

const NAME_START = /[A-Za-z_$]/u;
const NAME_PART = /[A-Za-z0-9_$]/u;

function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;

  const advanceLines = (from: number, to: number): void => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (source[cursor] === "\n") {
        line += 1;
        lineStart = cursor + 1;
      }
    }
  };

  while (index < source.length) {
    const character = source[index]!;
    if (character === "\r" || character === " " || character === "\t" || character === "\n") {
      if (character === "\n") {
        line += 1;
        lineStart = index + 1;
      }
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return undefined;
      advanceLines(index, end + 2);
      index = end + 2;
      continue;
    }
    if (source.startsWith('"""', index)) {
      const start = index;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      index += 3;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source.startsWith('"""', index)) {
          index += 3;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return undefined;
      advanceLines(start, index);
      tokens.push({ kind: "string", value: "", line: startLine, column: startColumn, offset: start });
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === character) {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] === "\n") break;
        index += 1;
      }
      if (!closed) return undefined;
      tokens.push({ kind: "string", value: "", line: startLine, column: startColumn, offset: start });
      continue;
    }
    if (NAME_START.test(character)) {
      const start = index;
      while (index < source.length && NAME_PART.test(source[index]!)) index += 1;
      tokens.push({
        kind: "name",
        value: source.slice(start, index),
        line,
        column: start - lineStart + 1,
        offset: start,
      });
      continue;
    }
    tokens.push({ kind: "op", value: character, line, column: index - lineStart + 1, offset: index });
    index += 1;
  }

  return tokens;
}

function isName(token: Token | undefined, value: string): boolean {
  return token?.kind === "name" && token.value === value;
}

function isOp(token: Token | undefined, value: string): boolean {
  return token?.kind === "op" && token.value === value;
}

function dottedName(tokens: readonly Token[], start: number): { name: string; end: number } | undefined {
  const first = tokens[start];
  if (first?.kind !== "name") return undefined;
  let name = first.value;
  let index = start + 1;
  while (isOp(tokens[index], ".") && tokens[index + 1]?.kind === "name") {
    name += `.${tokens[index + 1]!.value}`;
    index += 2;
  }
  return { name, end: index };
}

/**
 * Extracts the package declaration and import statements from Java source
 * with a bounded tokenizer: comments, strings, chars, and text blocks cannot
 * create edges. Wildcard imports carry a trailing `.*` marker and static
 * imports use the static-import kind, so the resolver can treat them
 * conservatively. Unterminated strings or comments make parsing partial.
 */
export function parseJavaImports(path: string, source: string): JavaImportParseResult {
  const tokens = tokenize(source);
  if (tokens === undefined) {
    return {
      status: "partial",
      imports: [],
      dynamicBoundaryCount: 0,
      limitations: [`${path}: Java source has an unterminated string, character, text block, or comment.`],
    };
  }

  const imports: SafeImportReference[] = [];
  let packageName: string | undefined;
  let statementStart = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "op") {
      if (token.value === ";" || token.value === "{" || token.value === "}") statementStart = true;
      continue;
    }
    if (token.kind !== "name" || !statementStart) {
      statementStart = false;
      continue;
    }

    if (token.value === "package") {
      const dotted = dottedName(tokens, index + 1);
      if (dotted !== undefined) {
        packageName = dotted.name;
        index = dotted.end - 1;
      }
      statementStart = false;
      continue;
    }

    if (token.value === "import") {
      let cursor = index + 1;
      const isStatic = isName(tokens[cursor], "static");
      if (isStatic) cursor += 1;
      const dotted = dottedName(tokens, cursor);
      if (dotted === undefined) {
        statementStart = false;
        continue;
      }
      cursor = dotted.end;
      let specifier = dotted.name;
      if (isOp(tokens[cursor], ".") && isOp(tokens[cursor + 1], "*")) {
        specifier = `${specifier}.*`;
        cursor += 2;
      }
      imports.push(createImportReference(
        isStatic ? "static-import" : "static",
        specifier,
        { line: token.line, column: token.column },
        token.offset,
      ));
      index = cursor - 1;
      statementStart = false;
      continue;
    }

    statementStart = false;
  }

  imports.sort((left, right) =>
    importSourceOffset(left) - importSourceOffset(right) ||
    left.kind.localeCompare(right.kind)
  );

  return {
    status: "completed",
    ...(packageName === undefined ? {} : { packageName }),
    imports,
    dynamicBoundaryCount: 0,
    limitations: [],
  };
}
