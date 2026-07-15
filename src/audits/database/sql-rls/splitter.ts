import type { SplitSqlResult, SqlDiagnostic, SqlStatement } from "./types.js";

type Mode = "normal" | "single" | "double" | "line-comment" | "block-comment" | "dollar";

function dollarTagAt(source: string, index: number): string | undefined {
  const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0];
}

export function splitSql(path: string, source: string): SplitSqlResult {
  const statements: SqlStatement[] = [];
  const diagnostics: SqlDiagnostic[] = [];
  let mode: Mode = "normal";
  let dollarTag = "";
  let blockDepth = 0;
  let parentheses = 0;
  let line = 1;
  let statementStart: number | undefined;
  let statementStartLine = 1;

  function startStatement(index: number): void {
    if (statementStart !== undefined) return;
    statementStart = index;
    statementStartLine = line;
  }

  function finishStatement(end: number): void {
    if (statementStart === undefined) return;
    const text = source.slice(statementStart, end).trim();
    if (text.length > 0) {
      statements.push({
        path,
        startLine: statementStartLine,
        endLine: line,
        text,
      });
    }
    statementStart = undefined;
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];

    if (mode === "line-comment") {
      if (character === "\n") {
        mode = "normal";
        line += 1;
      }
      continue;
    }

    if (mode === "block-comment") {
      if (character === "/" && next === "*") {
        blockDepth += 1;
        index += 1;
      } else if (character === "*" && next === "/") {
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) mode = "normal";
      } else if (character === "\n") {
        line += 1;
      }
      continue;
    }

    if (mode === "single") {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        mode = "normal";
      } else if (character === "\n") {
        line += 1;
      }
      continue;
    }

    if (mode === "double") {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        mode = "normal";
      } else if (character === "\n") {
        line += 1;
      }
      continue;
    }

    if (mode === "dollar") {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        mode = "normal";
      } else if (character === "\n") {
        line += 1;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      mode = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      mode = "block-comment";
      blockDepth = 1;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      if (character === "\n") line += 1;
      continue;
    }

    startStatement(index);
    if (character === "'") {
      mode = "single";
      continue;
    }
    if (character === '"') {
      mode = "double";
      continue;
    }
    if (character === "$") {
      const tag = dollarTagAt(source, index);
      if (tag !== undefined) {
        dollarTag = tag;
        mode = "dollar";
        index += tag.length - 1;
        continue;
      }
    }
    if (character === "(") {
      parentheses += 1;
      continue;
    }
    if (character === ")") {
      parentheses = Math.max(0, parentheses - 1);
      continue;
    }
    if (character === ";" && parentheses === 0) {
      finishStatement(index + 1);
    }
  }

  if (mode === "line-comment") mode = "normal";
  const incomplete = mode !== "normal" || parentheses !== 0;
  if (incomplete) {
    const reason = mode === "block-comment"
      ? "Unterminated block comment."
      : mode === "single" || mode === "double"
        ? "Unterminated quoted SQL value or identifier."
        : mode === "dollar"
          ? "Unterminated dollar-quoted SQL body."
          : "Unbalanced SQL parentheses.";
    diagnostics.push({ path, line: statementStartLine, message: reason });
  }
  finishStatement(source.length);

  return { statements, diagnostics, complete: diagnostics.length === 0 };
}
