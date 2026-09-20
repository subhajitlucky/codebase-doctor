import {
  createImportReference,
  importSourceOffset,
  type SafeImportReference,
} from "./references.js";

export interface RustImportParseResult {
  readonly status: "completed" | "partial";
  readonly imports: readonly SafeImportReference[];
  readonly dynamicBoundaryCount: number;
  readonly limitations: readonly string[];
}

interface Token {
  readonly kind: "name" | "op";
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

const NAME_START = /[A-Za-z_]/u;
const NAME_PART = /[A-Za-z0-9_]/u;

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
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      if (depth > 0) return undefined;
      advanceLines(index, cursor);
      index = cursor;
      continue;
    }

    const rawPrefix = /^(?:b?r|br)(#*)"/u.exec(source.slice(index));
    if (rawPrefix !== null) {
      const hashes = rawPrefix[1] ?? "";
      const closing = `"${hashes}`;
      const start = index;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      const end = source.indexOf(closing, index + rawPrefix[0].length);
      if (end < 0) return undefined;
      index = end + closing.length;
      advanceLines(start, index);
      tokens.push({ kind: "name", value: "", line: startLine, column: startColumn, offset: start });
      continue;
    }
    if (character === '"' || (character === "b" && source[index + 1] === '"')) {
      const start = index;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      index += character === '"' ? 1 : 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] === "\n") break;
        index += 1;
      }
      if (!closed) return undefined;
      advanceLines(start, index);
      tokens.push({ kind: "name", value: "", line: startLine, column: startColumn, offset: start });
      continue;
    }
    if (character === "'") {
      const next = source[index + 1];
      const after = source[index + 2];
      if (next === "\\") {
        let cursor = index + 2;
        while (cursor < source.length && source[cursor] !== "'") cursor += 1;
        if (cursor >= source.length) return undefined;
        index = cursor + 1;
        continue;
      }
      if (next !== undefined && after === "'") {
        index += 3;
        continue;
      }
      index += 1;
      while (index < source.length && NAME_PART.test(source[index]!)) index += 1;
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
    if (character === ":" && source[index + 1] === ":") {
      tokens.push({ kind: "op", value: "::", line, column: index - lineStart + 1, offset: index });
      index += 2;
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

/**
 * Collects `use` paths, expanding brace groups into fully qualified paths:
 * `use crate::a::{b, c::{d}};` yields `crate::a::b`, `crate::a::c::d`.
 */
function collectUsePaths(tokens: readonly Token[], start: number): { paths: string[]; end: number } {
  const paths: string[] = [];
  const stack: string[] = [""];
  let current = "";
  let index = start;

  const flush = (): void => {
    if (current.length > 0) {
      paths.push(`${stack.at(-1) ?? ""}${current}`);
      current = "";
    }
  };

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (isOp(token, ";")) {
      flush();
      return { paths, end: index + 1 };
    }
    if (token.kind === "name") {
      if (token.value === "as") {
        index += 2;
        continue;
      }
      current += token.value;
      index += 1;
      continue;
    }
    if (isOp(token, "::")) {
      current += "::";
      index += 1;
      continue;
    }
    if (isOp(token, "{")) {
      stack.push(`${stack.at(-1) ?? ""}${current}`);
      current = "";
      index += 1;
      continue;
    }
    if (isOp(token, ",")) {
      flush();
      index += 1;
      continue;
    }
    if (isOp(token, "}")) {
      flush();
      stack.pop();
      index += 1;
      continue;
    }
    if (isOp(token, "*")) {
      current += "*";
      index += 1;
      continue;
    }
    index += 1;
  }
  flush();
  return { paths, end: index };
}

/**
 * Extracts Rust module declarations and use paths with a bounded tokenizer:
 * line comments, nested block comments, strings, raw strings, chars, and
 * lifetimes cannot create edges. Brace groups in `use` statements are expanded
 * into complete paths. Unterminated strings or comments make parsing partial.
 */
export function parseRustImports(path: string, source: string): RustImportParseResult {
  const tokens = tokenize(source);
  if (tokens === undefined) {
    return {
      status: "partial",
      imports: [],
      dynamicBoundaryCount: 0,
      limitations: [`${path}: Rust source has an unterminated string, char, or comment.`],
    };
  }

  const imports: SafeImportReference[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "name") continue;

    if (token.value === "mod") {
      const name = tokens[index + 1];
      if (name?.kind !== "name") continue;
      imports.push(createImportReference(
        "module",
        name.value,
        { line: token.line, column: token.column },
        token.offset,
      ));
      index += 1;
      continue;
    }

    if (token.value === "use") {
      const collected = collectUsePaths(tokens, index + 1);
      for (const specifier of collected.paths) {
        imports.push(createImportReference(
          "static",
          specifier,
          { line: token.line, column: token.column },
          token.offset,
        ));
      }
      index = collected.end - 1;
    }
  }

  imports.sort((left, right) =>
    importSourceOffset(left) - importSourceOffset(right) ||
    left.kind.localeCompare(right.kind)
  );

  return {
    status: "completed",
    imports,
    dynamicBoundaryCount: 0,
    limitations: [],
  };
}
