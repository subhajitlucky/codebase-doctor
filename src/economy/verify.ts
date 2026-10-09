import { createHash } from "node:crypto";
import { canonicalJson } from "../receipts/receipt.js";
import type { EconomicInvariant, EconomicPolicy, LedgerJournal, LedgerOperation } from "./ledger.js";

export type EconomicStatus = "proved" | "violated" | "undecided";

export interface EconomicWitness {
  operationId: string;
  index: number;
  detail: string;
  balances: Record<string, number>;
}

export interface EconomicClaimResult {
  id: string;
  kind: EconomicInvariant["kind"];
  status: EconomicStatus;
  reason: string;
  witness?: EconomicWitness;
}

export interface EconomicReport {
  economyVersion: "1";
  tool: { name: "codebase-doctor"; version: string };
  generatedAt: string;
  subject: { journal: string; policy: string | null };
  currency: string | null;
  operations: number;
  claims: EconomicClaimResult[];
  summary: { claims: number; proved: number; violated: number; undecided: number };
  digest: { algorithm: "sha256"; value: string };
}

interface Replay {
  balances: Record<string, number>;
  snapshots: { operation: LedgerOperation; index: number; balances: Record<string, number> }[];
}

function replay(journal: LedgerJournal): Replay {
  const balances: Record<string, number> = { ...journal.accounts };
  const ensure = (name: string): number => {
    balances[name] ??= 0;
    return balances[name]!;
  };
  const snapshots: Replay["snapshots"] = [];

  for (const [index, operation] of journal.operations.entries()) {
    switch (operation.kind) {
      case "transfer":
        ensure(operation.from);
        ensure(operation.to);
        balances[operation.from]! -= operation.amount;
        balances[operation.to]! += operation.amount;
        break;
      case "deposit":
      case "mint":
        ensure(operation.to);
        balances[operation.to]! += operation.amount;
        break;
      case "withdraw":
      case "burn":
        ensure(operation.from);
        balances[operation.from]! -= operation.amount;
        break;
    }
    snapshots.push({ operation, index, balances: { ...balances } });
  }
  return { balances, snapshots };
}

function witnessOf(
  snapshot: Replay["snapshots"][number],
  detail: string,
): EconomicWitness {
  return {
    operationId: snapshot.operation.id,
    index: snapshot.index,
    detail,
    balances: snapshot.balances,
  };
}

function evaluateInvariant(invariant: EconomicInvariant, journal: LedgerJournal, replayResult: Replay): EconomicClaimResult {
  const base = { id: invariant.id, kind: invariant.kind };
  switch (invariant.kind) {
    case "non-negative-balances": {
      for (const snapshot of replayResult.snapshots) {
        const negative = Object.entries(snapshot.balances)
          .filter(([, balance]) => balance < 0)
          .sort(([left], [right]) => left.localeCompare(right));
        if (negative.length > 0) {
          return {
            ...base,
            status: "violated",
            reason: `account ${negative[0]![0]} reaches ${negative[0]![1]}`,
            witness: witnessOf(snapshot, `after ${snapshot.operation.id}`),
          };
        }
      }
      return { ...base, status: "proved", reason: `no account went negative across ${journal.operations.length} operation(s)` };
    }
    case "per-operation-limit": {
      for (const snapshot of replayResult.snapshots) {
        if (snapshot.operation.amount > invariant.maxAmount) {
          return {
            ...base,
            status: "violated",
            reason: `amount ${snapshot.operation.amount} exceeds limit ${invariant.maxAmount}`,
            witness: witnessOf(snapshot, `${snapshot.operation.kind} ${snapshot.operation.amount} > ${invariant.maxAmount}`),
          };
        }
      }
      return { ...base, status: "proved", reason: `every operation is within ${invariant.maxAmount}` };
    }
    case "allowlist": {
      const allowed = new Set(invariant.accounts);
      for (const snapshot of replayResult.snapshots) {
        const operation = snapshot.operation;
        if (operation.kind === "transfer" && !allowed.has(operation.to)) {
          return {
            ...base,
            status: "violated",
            reason: `counterparty ${operation.to} is not on the allowlist`,
            witness: witnessOf(snapshot, `destination ${operation.to}`),
          };
        }
      }
      return { ...base, status: "proved", reason: `every transfer counterparty is on the allowlist (${invariant.accounts.length} entries)` };
    }
    case "window-volume-limit": {
      const amounts = replayResult.snapshots.map((snapshot) =>
        snapshot.operation.kind === "transfer" ? snapshot.operation.amount : 0
      );
      for (let end = invariant.window - 1; end < amounts.length; end += 1) {
        const start = end - invariant.window + 1;
        const volume = amounts.slice(start, end + 1).reduce((sum, amount) => sum + amount, 0);
        if (volume > invariant.maxAmount) {
          const snapshot = replayResult.snapshots[end]!;
          return {
            ...base,
            status: "violated",
            reason: `window of ${invariant.window} operation(s) moves ${volume} > ${invariant.maxAmount}`,
            witness: witnessOf(snapshot, `window ends at ${snapshot.operation.id}`),
          };
        }
      }
      return {
        ...base,
        status: "proved",
        reason: `no ${invariant.window}-operation window exceeds ${invariant.maxAmount}`,
      };
    }
    case "declared-balances": {
      if (journal.expectedBalances === undefined) {
        return { ...base, status: "undecided", reason: "journal declares no expected balances" };
      }
      const mismatches: string[] = [];
      for (const [name, expected] of Object.entries(journal.expectedBalances).sort(([left], [right]) => left.localeCompare(right))) {
        const actual = replayResult.balances[name] ?? 0;
        if (actual !== expected) {
          mismatches.push(`${name}: expected ${expected}, replayed ${actual}`);
        }
      }
      for (const [name, actual] of Object.entries(replayResult.balances).sort(([left], [right]) => left.localeCompare(right))) {
        if (actual !== 0 && journal.expectedBalances[name] === undefined) {
          mismatches.push(`${name}: replayed ${actual} but not declared`);
        }
      }
      if (mismatches.length > 0) {
        return {
          ...base,
          status: "violated",
          reason: `${mismatches.length} declared balance mismatch(es)`,
          witness: {
            operationId: journal.operations.at(-1)?.id ?? "(none)",
            index: Math.max(0, journal.operations.length - 1),
            detail: mismatches.slice(0, 3).join("; "),
            balances: replayResult.balances,
          },
        };
      }
      return { ...base, status: "proved", reason: "declared balances match the replay exactly" };
    }
  }
}

export function evaluateEconomy(
  journal: LedgerJournal,
  policy: EconomicPolicy,
): EconomicClaimResult[] {
  const replayResult = replay(journal);
  return policy.invariants.map((invariant) => evaluateInvariant(invariant, journal, replayResult));
}

export function buildEconomyReport(
  claims: readonly EconomicClaimResult[],
  journal: LedgerJournal,
  subject: { journal: string; policy: string | null },
  toolVersion: string,
  generatedAt: Date = new Date(),
): EconomicReport {
  const body = {
    economyVersion: "1" as const,
    tool: { name: "codebase-doctor" as const, version: toolVersion },
    generatedAt: generatedAt.toISOString(),
    subject,
    currency: journal.currency ?? null,
    operations: journal.operations.length,
    claims: [...claims],
    summary: {
      claims: claims.length,
      proved: claims.filter((claim) => claim.status === "proved").length,
      violated: claims.filter((claim) => claim.status === "violated").length,
      undecided: claims.filter((claim) => claim.status === "undecided").length,
    },
  };
  return {
    ...body,
    digest: {
      algorithm: "sha256",
      value: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"),
    },
  };
}

export function renderEconomyText(report: EconomicReport): string {
  const lines = [
    "Codebase Doctor Economic Verification",
    "=====================================",
    "",
    `Journal: ${report.subject.journal} · ${report.operations} operation(s)` +
    `${report.currency === null ? "" : ` · currency ${report.currency}`}`,
    `Policy: ${report.subject.policy ?? "default invariants"}`,
    "",
  ];
  for (const claim of report.claims) {
    lines.push(`${claim.status.toUpperCase().padEnd(9)} ${claim.id} (${claim.kind}) — ${claim.reason}`);
    if (claim.witness !== undefined) {
      lines.push(
        `          witness: ${claim.witness.operationId} (index ${claim.witness.index}) — ${claim.witness.detail}`,
      );
    }
  }
  lines.push(
    "",
    `Summary: ${report.summary.proved} proved, ${report.summary.violated} violated, ` +
    `${report.summary.undecided} undecided of ${report.summary.claims} invariant(s).`,
    report.summary.violated > 0
      ? "Exit code 1: at least one invariant is violated before any real value moved."
      : report.summary.undecided > 0
        ? "Exit code 0: no violation; undecided invariants are never counted as proved."
        : "Exit code 0: every invariant is proved by the replay.",
    "The ledger exists only inside this process — nothing was submitted, nothing moved.",
  );
  return `${lines.join("\n")}\n`;
}
