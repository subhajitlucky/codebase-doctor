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
