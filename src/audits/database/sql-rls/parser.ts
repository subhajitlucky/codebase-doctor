import type {
  ParsedSqlStatement,
  SqlObjectName,
  SqlPolicyCommand,
  SqlStatement,
  SqlTablePrivilege,
} from "./types.js";

interface Token {
  kind: "word" | "identifier" | "value" | "symbol";
  value: string;
  start: number;
  end: number;
}

const policyCommands = new Set<SqlPolicyCommand>([
  "ALL", "SELECT", "INSERT", "UPDATE", "DELETE",
]);
const tablePrivileges = new Set<SqlTablePrivilege>([
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE",
]);

function dollarTagAt(source: string, index: number): string | undefined {
  return source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (character === '"') {
      const start = index;
      let value = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      tokens.push({ kind: "identifier", value, start, end: index });
      continue;
    }
    if (character === "'") {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index] === "'") {
          index += 1;
          break;
        } else index += 1;
      }
      tokens.push({ kind: "value", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (character === "$") {
      const tag = dollarTagAt(source, index);
      if (tag !== undefined) {
        const start = index;
        index += tag.length;
        const end = source.indexOf(tag, index);
        index = end < 0 ? source.length : end + tag.length;
        tokens.push({ kind: "value", value: source.slice(start, index), start, end: index });
        continue;
      }
    }
    if (/[A-Za-z_0-9$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z_0-9$]/.test(source[index]!)) index += 1;
      tokens.push({ kind: "word", value: source.slice(start, index).toLowerCase(), start, end: index });
      continue;
    }
    tokens.push({ kind: "symbol", value: character, start: index, end: index + 1 });
    index += 1;
  }
  if (tokens.at(-1)?.value === ";") tokens.pop();
  return tokens;
}

class Cursor {
  index = 0;

  constructor(readonly tokens: readonly Token[], readonly source: string) {}

  get done(): boolean {
    return this.index >= this.tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  keyword(value: string): boolean {
    const token = this.peek();
    return token?.kind === "word" && token.value === value;
  }

  consumeKeyword(value: string): boolean {
    if (!this.keyword(value)) return false;
    this.index += 1;
    return true;
  }

  consumeSymbol(value: string): boolean {
    if (this.peek()?.kind !== "symbol" || this.peek()?.value !== value) return false;
    this.index += 1;
    return true;
  }

  identifier(): string | undefined {
    const token = this.peek();
    if (token?.kind !== "word" && token?.kind !== "identifier") return undefined;
    this.index += 1;
    return token.value;
  }

  objectName(): SqlObjectName | undefined {
    const first = this.identifier();
    if (first === undefined) return undefined;
    if (!this.consumeSymbol(".")) return { schema: "public", name: first };
    const second = this.identifier();
    return second === undefined ? undefined : { schema: first, name: second };
  }

  parenthesizedExpression(): string | undefined {
    const opening = this.peek();
    if (!this.consumeSymbol("(") || opening === undefined) return undefined;
    let depth = 1;
    const contentStart = opening.end;
    while (!this.done) {
      const token = this.peek()!;
      this.index += 1;
      if (token.kind === "symbol" && token.value === "(") depth += 1;
      if (token.kind === "symbol" && token.value === ")") {
        depth -= 1;
        if (depth === 0) return this.source.slice(contentStart, token.start).trim();
      }
    }
    return undefined;
  }
}

function unsupported(statement: SqlStatement, reason: string): ParsedSqlStatement {
  return { kind: "unsupported-relevant", statement, reason };
}

function parseCreateTable(cursor: Cursor, statement: SqlStatement): ParsedSqlStatement {
  if (cursor.consumeKeyword("if") && !(cursor.consumeKeyword("not") && cursor.consumeKeyword("exists"))) {
    return unsupported(statement, "Unsupported CREATE TABLE condition.");
  }
  const table = cursor.objectName();
  if (table === undefined || cursor.peek()?.value !== "(") {
    return unsupported(statement, "Unsupported CREATE TABLE form.");
  }
  if (cursor.parenthesizedExpression() === undefined || !cursor.done) {
    return unsupported(statement, "Unsupported trailing CREATE TABLE syntax.");
  }
  return { kind: "create-table", statement, table };
}

function parseDropTable(cursor: Cursor, statement: SqlStatement): ParsedSqlStatement {
  if (cursor.consumeKeyword("if") && !cursor.consumeKeyword("exists")) {
    return unsupported(statement, "Unsupported DROP TABLE condition.");
  }
  const table = cursor.objectName();
  if (table === undefined) return unsupported(statement, "Missing DROP TABLE target.");
  if (!cursor.done && !(cursor.consumeKeyword("cascade") || cursor.consumeKeyword("restrict"))) {
    return unsupported(statement, "Unsupported DROP TABLE form.");
  }
  return cursor.done
    ? { kind: "drop-table", statement, table }
    : unsupported(statement, "Unsupported trailing DROP TABLE syntax.");
}

function parseAlterTable(cursor: Cursor, statement: SqlStatement): ParsedSqlStatement {
  const table = cursor.objectName();
  if (table === undefined) return unsupported(statement, "Missing ALTER TABLE target.");
  const remaining = cursor.tokens.slice(cursor.index).map((token) => token.value);
  const exact = (...values: string[]) =>
    remaining.length === values.length && values.every((value, index) => remaining[index] === value);
  if (exact("enable", "row", "level", "security")) {
    return { kind: "set-rls", statement, table, enabled: true };
  }
  if (exact("disable", "row", "level", "security")) {
    return { kind: "set-rls", statement, table, enabled: false };
  }
  if (exact("force", "row", "level", "security")) {
    return { kind: "set-force-rls", statement, table, enabled: true };
  }
  if (exact("no", "force", "row", "level", "security")) {
    return { kind: "set-force-rls", statement, table, enabled: false };
  }
  if (remaining[0] === "rename" || remaining.includes("policy") || remaining.join(" ").includes("row level security")) {
    return unsupported(statement, "Unsupported RLS-relevant ALTER TABLE form.");
  }
  return { kind: "ignored", statement };
}

function parseRoles(cursor: Cursor, stopKeywords: ReadonlySet<string>): string[] | undefined {
  const roles: string[] = [];
  while (!cursor.done && !(cursor.peek()?.kind === "word" && stopKeywords.has(cursor.peek()!.value))) {
    const role = cursor.identifier();
    if (role === undefined) return undefined;
    roles.push(role);
    if (!cursor.consumeSymbol(",")) break;
  }
  return roles.length === 0 ? undefined : roles;
}

function consumeExpressionClause(cursor: Cursor, first: string, second?: string): string | undefined {
  if (!cursor.consumeKeyword(first)) return undefined;
  if (second !== undefined && !cursor.consumeKeyword(second)) return undefined;
  return cursor.parenthesizedExpression();
}

function parseCreatePolicy(cursor: Cursor, statement: SqlStatement): ParsedSqlStatement {
  const name = cursor.identifier();
  if (name === undefined || !cursor.consumeKeyword("on")) return unsupported(statement, "Invalid CREATE POLICY target.");
  const table = cursor.objectName();
  if (table === undefined) return unsupported(statement, "Invalid CREATE POLICY table.");
  let permissive = true;
  let command: SqlPolicyCommand = "ALL";
  let roles: readonly string[] = ["public"];
  let usingExpression: string | null = null;
  let checkExpression: string | null = null;
  if (cursor.consumeKeyword("as")) {
    if (cursor.consumeKeyword("permissive")) permissive = true;
    else if (cursor.consumeKeyword("restrictive")) permissive = false;
    else return unsupported(statement, "Invalid policy permissiveness.");
  }
  if (cursor.consumeKeyword("for")) {
    const value = cursor.identifier()?.toUpperCase() as SqlPolicyCommand | undefined;
    if (value === undefined || !policyCommands.has(value)) return unsupported(statement, "Unsupported policy command.");
    command = value;
  }
  if (cursor.consumeKeyword("to")) {
    const parsedRoles = parseRoles(cursor, new Set(["using", "with"]));
    if (parsedRoles === undefined) return unsupported(statement, "Invalid policy role list.");
    roles = parsedRoles;
  }
  if (cursor.keyword("using")) {
    usingExpression = consumeExpressionClause(cursor, "using") ?? null;
    if (usingExpression === null) return unsupported(statement, "Invalid USING expression.");
  }
  if (cursor.keyword("with")) {
    checkExpression = consumeExpressionClause(cursor, "with", "check") ?? null;
    if (checkExpression === null) return unsupported(statement, "Invalid WITH CHECK expression.");
  }
  return cursor.done
    ? { kind: "create-policy", statement, table, name, command, permissive, roles, usingExpression, checkExpression }
    : unsupported(statement, "Unsupported trailing CREATE POLICY syntax.");
}

function parseAlterPolicy(cursor: Cursor, statement: SqlStatement): ParsedSqlStatement {
  const name = cursor.identifier();
  if (name === undefined || !cursor.consumeKeyword("on")) return unsupported(statement, "Invalid ALTER POLICY target.");
  const table = cursor.objectName();
  if (table === undefined) return unsupported(statement, "Invalid ALTER POLICY table.");
  let roles: readonly string[] | undefined;
  let usingExpression: string | undefined;
  let checkExpression: string | undefined;
  if (cursor.consumeKeyword("to")) {
    roles = parseRoles(cursor, new Set(["using", "with"]));
    if (roles === undefined) return unsupported(statement, "Invalid policy role list.");
  }
  if (cursor.keyword("using")) {
    usingExpression = consumeExpressionClause(cursor, "using");
    if (usingExpression === undefined) return unsupported(statement, "Invalid USING expression.");
  }
  if (cursor.keyword("with")) {
    checkExpression = consumeExpressionClause(cursor, "with", "check");
    if (checkExpression === undefined) return unsupported(statement, "Invalid WITH CHECK expression.");
  }
  if (roles === undefined && usingExpression === undefined && checkExpression === undefined) {
    return unsupported(statement, "ALTER POLICY contains no supported change.");
  }
  return cursor.done
    ? { kind: "alter-policy", statement, table, name, ...(roles === undefined ? {} : { roles }), ...(usingExpression === undefined ? {} : { usingExpression }), ...(checkExpression === undefined ? {} : { checkExpression }) }
    : unsupported(statement, "Unsupported trailing ALTER POLICY syntax.");
}

function parseDropPolicy(cursor: Cursor, statement: SqlStatement): ParsedSqlStatement {
  if (cursor.consumeKeyword("if") && !cursor.consumeKeyword("exists")) {
    return unsupported(statement, "Unsupported DROP POLICY condition.");
  }
  const name = cursor.identifier();
  if (name === undefined || !cursor.consumeKeyword("on")) return unsupported(statement, "Invalid DROP POLICY target.");
  const table = cursor.objectName();
  if (table === undefined) return unsupported(statement, "Invalid DROP POLICY table.");
  if (!cursor.done && !(cursor.consumeKeyword("cascade") || cursor.consumeKeyword("restrict"))) {
    return unsupported(statement, "Unsupported DROP POLICY form.");
  }
  return cursor.done
    ? { kind: "drop-policy", statement, table, name }
    : unsupported(statement, "Unsupported trailing DROP POLICY syntax.");
}

function parsePrivilegeChange(cursor: Cursor, statement: SqlStatement, kind: "grant" | "revoke"): ParsedSqlStatement {
  const privileges: SqlTablePrivilege[] = [];
  while (!cursor.done && !cursor.keyword("on")) {
    const privilege = cursor.identifier()?.toUpperCase() as SqlTablePrivilege | undefined;
    if (privilege === undefined || !tablePrivileges.has(privilege)) {
      return unsupported(statement, "Unsupported table privilege.");
    }
    privileges.push(privilege);
    if (!cursor.consumeSymbol(",")) break;
  }
  if (privileges.length === 0 || !cursor.consumeKeyword("on")) return unsupported(statement, "Invalid table privilege statement.");
  cursor.consumeKeyword("table");
  const table = cursor.objectName();
  const connector = kind === "grant" ? "to" : "from";
  if (table === undefined || !cursor.consumeKeyword(connector)) return unsupported(statement, "Invalid table privilege target.");
  const roles = parseRoles(cursor, new Set());
  if (roles === undefined || !cursor.done) return unsupported(statement, "Invalid table privilege role list.");
  return { kind, statement, table, privileges, roles };
}

function containsRelevantTokens(tokens: readonly Token[]): boolean {
  const words = tokens.filter((token) => token.kind === "word").map((token) => token.value);
  return words.includes("policy") ||
    words.includes("execute") ||
    words.join(" ").includes("row level security");
}

export function parseSqlStatement(statement: SqlStatement): ParsedSqlStatement {
  const tokens = tokenize(statement.text);
  const cursor = new Cursor(tokens, statement.text);
  if (cursor.done) return { kind: "ignored", statement };

  if (cursor.consumeKeyword("create")) {
    if (cursor.consumeKeyword("table")) return parseCreateTable(cursor, statement);
    if (cursor.consumeKeyword("policy")) return parseCreatePolicy(cursor, statement);
    if (tokens.some((token) => token.kind === "word" && ["function", "procedure"].includes(token.value))) {
      return unsupported(statement, "Function and procedure bodies are not evaluated.");
    }
  } else if (cursor.consumeKeyword("alter")) {
    if (cursor.consumeKeyword("table")) return parseAlterTable(cursor, statement);
    if (cursor.consumeKeyword("policy")) return parseAlterPolicy(cursor, statement);
  } else if (cursor.consumeKeyword("drop")) {
    if (cursor.consumeKeyword("table")) return parseDropTable(cursor, statement);
    if (cursor.consumeKeyword("policy")) return parseDropPolicy(cursor, statement);
  } else if (cursor.consumeKeyword("grant")) {
    return parsePrivilegeChange(cursor, statement, "grant");
  } else if (cursor.consumeKeyword("revoke")) {
    return parsePrivilegeChange(cursor, statement, "revoke");
  } else if (cursor.keyword("do")) {
    return unsupported(statement, "Dynamic DO blocks are not evaluated.");
  }

  return containsRelevantTokens(tokens)
    ? unsupported(statement, "RLS-relevant SQL is outside the supported static subset.")
    : { kind: "ignored", statement };
}
