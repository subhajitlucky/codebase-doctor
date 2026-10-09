/**
 * Economic Doctor: a disposable in-memory ledger that replays a transaction
 * journal and decides declared economic invariants. It never contacts a
 * payment system, never moves real value, and always "rolls back" — the
 * ledger exists only inside this process.
 */

export type LedgerOperation =
  | { id: string; kind: "transfer"; from: string; to: string; amount: number }
  | { id: string; kind: "deposit"; to: string; amount: number }
  | { id: string; kind: "withdraw"; from: string; amount: number }
  | { id: string; kind: "mint"; to: string; amount: number }
  | { id: string; kind: "burn"; from: string; amount: number };

export interface LedgerJournal {
  journalVersion: "1";
  currency?: string;
  accounts: Record<string, number>;
  operations: LedgerOperation[];
  expectedBalances?: Record<string, number>;
}

export type EconomicInvariant =
  | { id: string; kind: "non-negative-balances" }
  | { id: string; kind: "per-operation-limit"; maxAmount: number }
  | { id: string; kind: "allowlist"; accounts: string[] }
  | { id: string; kind: "window-volume-limit"; window: number; maxAmount: number }
  | { id: string; kind: "declared-balances" };

export interface EconomicPolicy {
  policyVersion: "1";
  invariants: EconomicInvariant[];
}

export class LedgerError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LedgerError(`${field} must be a safe integer (minor units, e.g. cents).`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerError(`${field} must be a non-empty string.`);
  }
  return value;
}

function parseOperation(value: unknown, index: number): LedgerOperation {
  if (!isRecord(value)) {
    throw new LedgerError(`operation ${index + 1} is not an object.`);
  }
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : `op-${index + 1}`;
  const amount = requireInteger(value.amount, `operation "${id}" amount`);
  if (amount <= 0) {
    throw new LedgerError(`operation "${id}" amount must be positive.`);
  }
  switch (value.kind) {
    case "transfer":
      return {
        id,
        kind: "transfer",
        from: requireString(value.from, `operation "${id}" from`),
        to: requireString(value.to, `operation "${id}" to`),
        amount,
      };
    case "deposit":
      return { id, kind: "deposit", to: requireString(value.to, `operation "${id}" to`), amount };
    case "withdraw":
      return { id, kind: "withdraw", from: requireString(value.from, `operation "${id}" from`), amount };
    case "mint":
      return { id, kind: "mint", to: requireString(value.to, `operation "${id}" to`), amount };
    case "burn":
      return { id, kind: "burn", from: requireString(value.from, `operation "${id}" from`), amount };
    default:
      throw new LedgerError(`operation "${id}" has an unsupported kind: ${String(value.kind)}.`);
  }
}

export function parseJournal(text: string, source = "journal"): LedgerJournal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError(`${source} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new LedgerError(`${source} must be a JSON object.`);
  if (value.journalVersion !== "1") {
    throw new LedgerError(`${source} has an unsupported journalVersion: ${String(value.journalVersion)}.`);
  }
  if (!isRecord(value.accounts)) {
    throw new LedgerError(`${source} must declare an accounts object.`);
  }
  const accounts: Record<string, number> = {};
  for (const [name, balance] of Object.entries(value.accounts)) {
    accounts[name] = requireInteger(balance, `account "${name}" balance`);
  }
  if (!Array.isArray(value.operations)) {
    throw new LedgerError(`${source} must declare an operations array.`);
  }
  const operations = value.operations.map(parseOperation);
  let expectedBalances: Record<string, number> | undefined;
  if (value.expectedBalances !== undefined) {
    if (!isRecord(value.expectedBalances)) {
      throw new LedgerError(`${source} expectedBalances must be an object.`);
    }
    expectedBalances = {};
    for (const [name, balance] of Object.entries(value.expectedBalances)) {
      expectedBalances[name] = requireInteger(balance, `expected balance "${name}"`);
    }
  }
  return {
    journalVersion: "1",
    ...(typeof value.currency === "string" && value.currency.length > 0
      ? { currency: value.currency }
      : {}),
    accounts,
    operations,
    ...(expectedBalances === undefined ? {} : { expectedBalances }),
  };
}

export function parsePolicy(text: string, source = "policy"): EconomicPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError(`${source} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new LedgerError(`${source} must be a JSON object.`);
  if (value.policyVersion !== "1") {
    throw new LedgerError(`${source} has an unsupported policyVersion: ${String(value.policyVersion)}.`);
  }
  if (!Array.isArray(value.invariants) || value.invariants.length === 0) {
    throw new LedgerError(`${source} must declare at least one invariant.`);
  }
  const invariants = value.invariants.map((entry, index): EconomicInvariant => {
    if (!isRecord(entry)) throw new LedgerError(`invariant ${index + 1} is not an object.`);
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `invariant-${index + 1}`;
    switch (entry.kind) {
      case "non-negative-balances":
      case "declared-balances":
        return { id, kind: entry.kind };
      case "per-operation-limit":
        return { id, kind: entry.kind, maxAmount: requireInteger(entry.maxAmount, `invariant "${id}" maxAmount`) };
      case "allowlist": {
        if (!Array.isArray(entry.accounts) || entry.accounts.length === 0) {
          throw new LedgerError(`invariant "${id}" requires a non-empty accounts array.`);
        }
        return { id, kind: entry.kind, accounts: entry.accounts.map((account) => requireString(account, `invariant "${id}" account`)) };
      }
      case "window-volume-limit": {
        const window = requireInteger(entry.window, `invariant "${id}" window`);
        if (window <= 0) throw new LedgerError(`invariant "${id}" window must be positive.`);
        return {
          id,
          kind: entry.kind,
          window,
          maxAmount: requireInteger(entry.maxAmount, `invariant "${id}" maxAmount`),
        };
      }
      default:
        throw new LedgerError(`invariant "${id}" has an unsupported kind: ${String(entry.kind)}.`);
    }
  });
  return { policyVersion: "1", invariants };
}
