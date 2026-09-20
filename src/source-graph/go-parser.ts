import {
  createImportReference,
  importSourceOffset,
  type SafeImportReference,
} from "./references.js";

export interface GoImportParseResult {
  readonly status: "completed" | "partial";
  readonly imports: readonly SafeImportReference[];
  readonly dynamicBoundaryCount: number;
  readonly limitations: readonly string[];
}

interface Token {
  readonly kind: "name" | "string" | "op" | "newline";
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
    if (character === "\r" || character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      tokens.push({ kind: "newline", value: "\n", line, column: index - lineStart + 1, offset: index });
      index += 1;
      line += 1;
      lineStart = index;
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
    if (character === '"' || character === "`" || character === "'") {
      const start = index;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      index += 1;
      let closed = false;
      let value = "";
      while (index < source.length) {
        const current = source[index]!;
        if (character === "'") {
          if (current === "\\") {
            index += 2;
            continue;
          }
          if (current === "'") {
            closed = true;
            index += 1;
            break;
          }
          if (current === "\n") break;
          index += 1;
          continue;
        }
        if (character === '"') {
          if (current === "\\") {
            const escaped = source[index + 1];
            value += escaped === undefined ? "" : escaped;
            index += 2;
            continue;
          }
          if (current === '"') {
            closed = true;
            index += 1;
            break;
          }
          if (current === "\n") break;
          value += current;
          index += 1;
          continue;
        }
        if (current === "`") {
          closed = true;
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) return undefined;
      advanceLines(start, index);
      tokens.push({ kind: "string", value, line: startLine, column: startColumn, offset: start });
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

  tokens.push({ kind: "newline", value: "\n", line, column: 1, offset: source.length });
  return tokens;
}

function isName(token: Token | undefined, value: string): boolean {
  return token?.kind === "name" && token.value === value;
}

function isOp(token: Token | undefined, value: string): boolean {
  return token?.kind === "op" && token.value === value;
}

/**
 * Extracts Go import declarations with a bounded tokenizer: line and block
 * comments, interpreted strings, raw strings, and rune literals cannot create
 * edges. Go has no dynamic import statement, so the dynamic boundary count is
 * always zero. Unsupported import-block syntax becomes a limitation.
 */
export function parseGoImports(path: string, source: string): GoImportParseResult {
  const tokens = tokenize(source);
  if (tokens === undefined) {
    return {
      status: "partial",
      imports: [],
      dynamicBoundaryCount: 0,
      limitations: [`${path}: Go source has an unterminated string, rune, or comment.`],
    };
  }

  const imports: SafeImportReference[] = [];
  const limitations: string[] = [];
  let statementStart = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "newline") {
      statementStart = true;
      continue;
    }
    if (token.kind === "op") {
      if (token.value === ";") statementStart = true;
      continue;
    }
    if (!isName(token, "import") || !statementStart) {
      statementStart = false;
      continue;
    }

    let cursor = index + 1;
    while (tokens[cursor]?.kind === "newline") cursor += 1;

    if (isOp(tokens[cursor], "(")) {
      cursor += 1;
      let depth = 1;
      while (cursor < tokens.length && depth > 0) {
        const current = tokens[cursor]!;
        if (isOp(current, "(")) {
          depth += 1;
          cursor += 1;
          continue;
        }
        if (isOp(current, ")")) {
          depth -= 1;
          cursor += 1;
          continue;
        }
        if (current.kind === "newline" || isOp(current, ",")) {
          cursor += 1;
          continue;
        }
        let specifierToken: Token | undefined;
        if (current.kind === "string") {
          specifierToken = current;
        } else if (current.kind === "name" || isOp(current, ".")) {
          const next = tokens[cursor + 1];
          if (next?.kind === "string") {
            specifierToken = next;
            cursor += 2;
          } else {
            cursor += 1;
          }
        } else {
          limitations.push(`${path}: Go import block syntax was not fully recognized.`);
          cursor += 1;
          continue;
        }
        if (specifierToken !== undefined && specifierToken.kind === "string") {
          imports.push(createImportReference(
            "static",
            specifierToken.value,
            { line: specifierToken.line, column: specifierToken.column },
            specifierToken.offset,
          ));
          if (current.kind === "string") cursor += 1;
        }
      }
      statementStart = false;
      continue;
    }

    const next = tokens[cursor];
    if (next?.kind === "string") {
      imports.push(createImportReference(
        "static",
        next.value,
        { line: token.line, column: token.column },
        token.offset,
      ));
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
    imports,
    dynamicBoundaryCount: 0,
    limitations: [...new Set(limitations)].sort(),
  };
}
