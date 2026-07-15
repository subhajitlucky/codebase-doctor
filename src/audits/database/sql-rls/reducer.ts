import type {
  ParsedSqlStatement,
  SqlObjectName,
  SqlStatement,
  SqlStreamState,
  StaticGrantState,
  StaticPolicyState,
  StaticTableState,
} from "./types.js";

interface MutableTableState {
  schema: string;
  name: string;
  declaredInStream: boolean;
  dropped: boolean;
  rlsEnabled: boolean | "unknown";
  forceRls: boolean | "unknown";
  policiesComplete: boolean;
  grantsComplete: boolean;
  policies: Map<string, StaticPolicyState>;
  grants: Map<string, StaticGrantState>;
  lastEvidence: SqlStatement;
  rlsEvidence?: SqlStatement;
  forceRlsEvidence?: SqlStatement;
}

function tableKey(table: SqlObjectName): string {
  return `${table.schema}\u0000${table.name}`;
}

function grantKey(role: string, privilege: string): string {
  return `${privilege}\u0000${role}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function newReferencedTable(table: SqlObjectName, evidence: SqlStatement): MutableTableState {
  return {
    schema: table.schema,
    name: table.name,
    declaredInStream: false,
    dropped: false,
    rlsEnabled: "unknown",
    forceRls: "unknown",
    policiesComplete: false,
    grantsComplete: false,
    policies: new Map(),
    grants: new Map(),
    lastEvidence: evidence,
  };
}

function createdTable(table: SqlObjectName, evidence: SqlStatement): MutableTableState {
  return {
    ...newReferencedTable(table, evidence),
    declaredInStream: true,
    rlsEnabled: false,
    forceRls: false,
    policiesComplete: true,
    grantsComplete: true,
    rlsEvidence: evidence,
    forceRlsEvidence: evidence,
  };
}

function immutableTable(table: MutableTableState): StaticTableState {
  const policies = [...table.policies.values()]
    .sort((left, right) => compareText(left.name, right.name));
  const grants = [...table.grants.values()]
    .sort((left, right) => compareText(grantKey(left.role, left.privilege), grantKey(right.role, right.privilege)));
  return {
    schema: table.schema,
    name: table.name,
    declaredInStream: table.declaredInStream,
    dropped: table.dropped,
    rlsEnabled: table.rlsEnabled,
    forceRls: table.forceRls,
    policiesComplete: table.policiesComplete,
    grantsComplete: table.grantsComplete,
    policies,
    grants,
    lastEvidence: table.lastEvidence,
    ...(table.rlsEvidence === undefined ? {} : { rlsEvidence: table.rlsEvidence }),
    ...(table.forceRlsEvidence === undefined ? {} : { forceRlsEvidence: table.forceRlsEvidence }),
  };
}

export function reduceSqlStream(
  streamId: string,
  operations: readonly ParsedSqlStatement[],
): SqlStreamState {
  const tables = new Map<string, MutableTableState>();
  const limitations: string[] = [];
  let statementsRecognized = 0;

  function getTable(table: SqlObjectName, evidence: SqlStatement): MutableTableState {
    const key = tableKey(table);
    const existing = tables.get(key);
    if (existing !== undefined) return existing;
    const created = newReferencedTable(table, evidence);
    tables.set(key, created);
    return created;
  }

  for (const operation of operations) {
    if (operation.kind === "ignored") continue;
    if (operation.kind === "unsupported-relevant") {
      limitations.push(`${operation.statement.path}:${operation.statement.startLine}: ${operation.reason}`);
      continue;
    }
    statementsRecognized += 1;

    if (operation.kind === "create-table") {
      tables.set(tableKey(operation.table), createdTable(operation.table, operation.statement));
      continue;
    }

    const table = getTable(operation.table, operation.statement);
    table.lastEvidence = operation.statement;
    table.dropped = false;

    switch (operation.kind) {
      case "drop-table":
        table.dropped = true;
        table.policies.clear();
        table.grants.clear();
        break;
      case "set-rls":
        table.rlsEnabled = operation.enabled;
        table.rlsEvidence = operation.statement;
        break;
      case "set-force-rls":
        table.forceRls = operation.enabled;
        table.forceRlsEvidence = operation.statement;
        break;
      case "create-policy":
        table.policies.set(operation.name, {
          name: operation.name,
          command: operation.command,
          permissive: operation.permissive,
          roles: [...operation.roles],
          usingExpression: operation.usingExpression,
          checkExpression: operation.checkExpression,
          evidence: operation.statement,
          commandEvidence: operation.statement,
          rolesEvidence: operation.statement,
          usingEvidence: operation.statement,
          checkEvidence: operation.statement,
        });
        break;
      case "alter-policy": {
        const existing = table.policies.get(operation.name) ?? {
          name: operation.name,
          command: "unknown" as const,
          permissive: "unknown" as const,
          roles: "unknown" as const,
          usingExpression: "unknown" as const,
          checkExpression: "unknown" as const,
          evidence: operation.statement,
        };
        table.policies.set(operation.name, {
          ...existing,
          ...(operation.roles === undefined ? {} : { roles: [...operation.roles] }),
          ...(operation.usingExpression === undefined ? {} : { usingExpression: operation.usingExpression }),
          ...(operation.checkExpression === undefined ? {} : { checkExpression: operation.checkExpression }),
          ...(operation.roles === undefined ? {} : { rolesEvidence: operation.statement }),
          ...(operation.usingExpression === undefined ? {} : { usingEvidence: operation.statement }),
          ...(operation.checkExpression === undefined ? {} : { checkEvidence: operation.statement }),
          evidence: operation.statement,
        });
        break;
      }
      case "drop-policy":
        table.policies.delete(operation.name);
        break;
      case "grant":
        for (const role of operation.roles) {
          for (const privilege of operation.privileges) {
            table.grants.set(grantKey(role, privilege), {
              role,
              privilege,
              evidence: operation.statement,
            });
          }
        }
        break;
      case "revoke":
        for (const role of operation.roles) {
          for (const privilege of operation.privileges) {
            table.grants.delete(grantKey(role, privilege));
          }
        }
        break;
    }
  }

  return {
    streamId,
    tables: [...tables.values()]
      .map(immutableTable)
      .sort((left, right) => compareText(`${left.schema}\u0000${left.name}`, `${right.schema}\u0000${right.name}`)),
    coverage: {
      status: limitations.length === 0 ? "completed" : "partial",
      statementsExamined: operations.length,
      statementsRecognized,
      limitations,
    },
  };
}
