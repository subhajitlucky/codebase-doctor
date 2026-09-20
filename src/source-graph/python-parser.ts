import {
  createImportReference,
  importSourceOffset,
  type SafeImportReference,
} from "./references.js";

export interface PythonImportParseResult {
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

interface StringScan {
  readonly end: number;
  readonly value: string;
}

const NAME_START = /[A-Za-z_]/u;
const NAME_PART = /[A-Za-z0-9_]/u;
const STRING_PREFIX = /^[rbufRBUF]{1,2}['"]/u;

function isStringPrefixAt(source: string, index: number): boolean {
  const prefix = STRING_PREFIX.exec(source.slice(index, index + 3));
  if (prefix === null) return false;
  const previous = index > 0 ? source[index - 1] : undefined;
  return previous === undefined || !/[A-Za-z0-9_]/u.test(previous);
}

function scanString(source: string, quoteIndex: number): StringScan | undefined {
  const quote = source[quoteIndex];
  const triple = source.startsWith(`${quote}${quote}${quote}`, quoteIndex);
  const delimiterLength = triple ? 3 : 1;
  let index = quoteIndex + delimiterLength;
  let value = "";
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) return undefined;
      if (escaped === "\\" || escaped === "'" || escaped === "\"") value += escaped;
      else value += `\\${escaped}`;
      index += 2;
      continue;
    }
    if (character === "\n" && !triple) return undefined;
    if (character === quote) {
      if (!triple) return { end: index + 1, value };
      if (source.startsWith(`${quote}${quote}${quote}`, index)) {
        return { end: index + 3, value };
      }
    }
    value += character;
    index += 1;
  }
  return undefined;
}

function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  let continued = false;

  while (index < source.length) {
    const character = source[index]!;
    if (character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      if (depth === 0 && !continued) {
        tokens.push({ kind: "newline", value: "\n", line, column: index - lineStart + 1, offset: index });
      }
      continued = false;
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }
    if (character === " " || character === "\t" || character === "\f") {
      index += 1;
      continue;
    }
    if (character === "\\" && source[index + 1] === "\n") {
      continued = true;
      index += 2;
      line += 1;
      lineStart = index;
      continue;
    }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    const quoteIndex = character === '"' || character === "'"
      ? index
      : isStringPrefixAt(source, index)
        ? index + (/^[rbufRBUF]{1,2}/u.exec(source.slice(index))?.[0].length ?? 0)
        : -1;
    if (quoteIndex >= 0) {
      const scanned = scanString(source, quoteIndex);
      if (scanned === undefined) return undefined;
      const startLine = line;
      const startColumn = index - lineStart + 1;
      for (let cursor = index; cursor < scanned.end; cursor += 1) {
        if (source[cursor] === "\n") {
          line += 1;
          lineStart = cursor + 1;
        }
      }
      tokens.push({
        kind: "string",
        value: scanned.value,
        line: startLine,
        column: startColumn,
        offset: index,
      });
      index = scanned.end;
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

    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
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
 * Extracts import statements from Python source with a bounded tokenizer, so
 * comments, strings, and multi-line string literals cannot produce edges.
 * Grammar coverage is statement-level: import lists, from-imports with
 * relative dots, and literal importlib/__import__ calls. Everything else is
 * counted as a dynamic boundary or reported as a limitation.
 */
export function parsePythonImports(path: string, source: string): PythonImportParseResult {
  const tokens = tokenize(source);
  if (tokens === undefined) {
    return {
      status: "partial",
      imports: [],
      dynamicBoundaryCount: 0,
      limitations: [`${path}: Python source has an unterminated string literal.`],
    };
  }

  const imports: SafeImportReference[] = [];
  let dynamicBoundaryCount = 0;
  let statementStart = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token.kind === "newline") {
      statementStart = true;
      continue;
    }
    if (token.kind === "op") {
      if (token.value === ";" || token.value === ":") statementStart = true;
      continue;
    }
    if (token.kind !== "name") {
      statementStart = false;
      continue;
    }

    if (token.value === "import_module" || token.value === "__import__") {
      if (isOp(tokens[index + 1], "(")) {
        const argument = tokens[index + 2];
        if (argument?.kind === "string" && argument.value.length > 0) {
          imports.push(createImportReference(
            "dynamic-literal",
            argument.value,
            { line: token.line, column: token.column },
            token.offset,
          ));
        } else {
          dynamicBoundaryCount += 1;
        }
      }
      statementStart = false;
      continue;
    }

    if (!statementStart) continue;

    if (token.value === "import") {
      let cursor = index + 1;
      let found = false;
      while (cursor < tokens.length && tokens[cursor]!.kind !== "newline") {
        const dotted = dottedName(tokens, cursor);
        if (dotted === undefined) break;
        imports.push(createImportReference(
          "static",
          dotted.name,
          { line: token.line, column: token.column },
          token.offset,
        ));
        found = true;
        cursor = dotted.end;
        if (isName(tokens[cursor], "as")) {
          cursor += 1;
          if (tokens[cursor]?.kind === "name") cursor += 1;
        }
        if (isOp(tokens[cursor], ",")) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (found) {
        index = cursor - 1;
        statementStart = false;
      }
      continue;
    }

    if (token.value === "from") {
      let cursor = index + 1;
      let dots = 0;
      while (isOp(tokens[cursor], ".")) {
        dots += 1;
        cursor += 1;
      }
      const module = isName(tokens[cursor], "import")
        ? undefined
        : dottedName(tokens, cursor);
      if (module !== undefined) cursor = module.end;
      if (!isName(tokens[cursor], "import")) continue;
      cursor += 1;

      const names: string[] = [];
      while (cursor < tokens.length && tokens[cursor]!.kind !== "newline") {
        if (tokens[cursor]!.kind === "name") {
          names.push(tokens[cursor]!.value);
          cursor += 1;
          if (isName(tokens[cursor], "as")) {
            cursor += 1;
            if (tokens[cursor]?.kind === "name") cursor += 1;
          }
        } else if (isOp(tokens[cursor], "*")) {
          names.push("*");
          cursor += 1;
        } else if (isOp(tokens[cursor], ",") || isOp(tokens[cursor], "(") || isOp(tokens[cursor], ")")) {
          cursor += 1;
          continue;
        } else {
          break;
        }
        if (isOp(tokens[cursor], ",")) cursor += 1;
      }

      const moduleName = module?.name ?? "";
      if (dots > 0 && moduleName.length === 0) {
        const targets = names.filter((name) => name !== "*");
        if (targets.length === 0) {
          imports.push(createImportReference(
            "static",
            ".".repeat(dots),
            { line: token.line, column: token.column },
            token.offset,
          ));
        } else {
          for (const name of targets) {
            imports.push(createImportReference(
              "static",
              `${".".repeat(dots)}${name}`,
              { line: token.line, column: token.column },
              token.offset,
            ));
          }
        }
      } else if (dots > 0 || moduleName.length > 0) {
        imports.push(createImportReference(
          "static",
          `${".".repeat(dots)}${moduleName}`,
          { line: token.line, column: token.column },
          token.offset,
        ));
      }
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
    imports,
    dynamicBoundaryCount,
    limitations: [],
  };
}
