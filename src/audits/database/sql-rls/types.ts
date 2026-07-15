export interface SqlMigrationStream {
  id: string;
  projectId: string;
  root: string;
  dialect: "postgresql";
  files: readonly string[];
}

export interface SqlStatement {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface SqlDiagnostic {
  path: string;
  line: number;
  message: string;
}

export interface SplitSqlResult {
  statements: readonly SqlStatement[];
  diagnostics: readonly SqlDiagnostic[];
  complete: boolean;
}

export interface SqlObjectName {
  schema: string;
  name: string;
}

export type SqlPolicyCommand = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export type SqlTablePrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE";

interface ParsedStatementBase {
  statement: SqlStatement;
}

export type ParsedSqlStatement =
  | (ParsedStatementBase & { kind: "create-table"; table: SqlObjectName })
  | (ParsedStatementBase & { kind: "drop-table"; table: SqlObjectName })
  | (ParsedStatementBase & {
      kind: "set-rls" | "set-force-rls";
      table: SqlObjectName;
      enabled: boolean;
    })
  | (ParsedStatementBase & {
      kind: "create-policy";
      table: SqlObjectName;
      name: string;
      command: SqlPolicyCommand;
      permissive: boolean;
      roles: readonly string[];
      usingExpression: string | null;
      checkExpression: string | null;
    })
  | (ParsedStatementBase & {
      kind: "alter-policy";
      table: SqlObjectName;
      name: string;
      roles?: readonly string[];
      usingExpression?: string;
      checkExpression?: string;
    })
  | (ParsedStatementBase & {
      kind: "drop-policy";
      table: SqlObjectName;
      name: string;
    })
  | (ParsedStatementBase & {
      kind: "grant" | "revoke";
      table: SqlObjectName;
      privileges: readonly SqlTablePrivilege[];
      roles: readonly string[];
    })
  | (ParsedStatementBase & { kind: "ignored" })
  | (ParsedStatementBase & { kind: "unsupported-relevant"; reason: string });
