import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerError, parseJournal, parsePolicy } from "../../src/economy/ledger.js";
import { buildEconomyReport, evaluateEconomy } from "../../src/economy/verify.js";
import { canonicalJson } from "../../src/receipts/receipt.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
  );
}

const JOURNAL = {
  journalVersion: "1",
  currency: "USD-cents",
  accounts: { agent: 1000, merchant: 0 },
  operations: [
    { id: "op-1", kind: "transfer", from: "agent", to: "merchant", amount: 400 },
    { id: "op-2", kind: "transfer", from: "agent", to: "merchant", amount: 700 },
  ],
  expectedBalances: { agent: 300, merchant: 1100 },
};

const POLICY = {
  policyVersion: "1",
  invariants: [
    { id: "no-overdraft", kind: "non-negative-balances" },
    { id: "op-limit", kind: "per-operation-limit", maxAmount: 500 },
    { id: "counterparties", kind: "allowlist", accounts: ["merchant"] },
    { id: "velocity", kind: "window-volume-limit", window: 2, maxAmount: 1000 },
    { id: "declared", kind: "declared-balances" },
  ],
};

function evaluate(journal: unknown = JOURNAL, policy: unknown = POLICY) {
  return evaluateEconomy(
    parseJournal(JSON.stringify(journal)),
    parsePolicy(JSON.stringify(policy)),
  );
}

describe("economic verification", () => {
  it("catches a double-spend with a witness at the exact operation", () => {
    const claims = evaluate();
    const overdraft = claims.find((claim) => claim.id === "no-overdraft");
    expect(overdraft).toMatchObject({
      status: "violated",
      reason: "account agent reaches -100",
      witness: { operationId: "op-2", index: 1 },
    });
    expect(overdraft?.witness?.balances.agent).toBe(-100);
  });

  it("decides limits, windows, and allowlists", () => {
    const claims = evaluate();
    expect(claims.find((claim) => claim.id === "op-limit")).toMatchObject({ status: "violated" });
    expect(claims.find((claim) => claim.id === "velocity")).toMatchObject({ status: "violated" });
    expect(claims.find((claim) => claim.id === "counterparties")).toMatchObject({ status: "proved" });

    const depositToSelf = evaluate({
      ...JOURNAL,
      operations: [{ id: "d", kind: "deposit", to: "agent", amount: 10 }],
      expectedBalances: { agent: 1010, merchant: 0 },
    });
    expect(depositToSelf.find((claim) => claim.id === "counterparties")).toMatchObject({ status: "proved" });

    const unlisted = evaluate({
      ...JOURNAL,
      operations: [{ id: "x", kind: "transfer", from: "agent", to: "stranger", amount: 10 }],
      expectedBalances: { agent: 990, stranger: 10 },
    });
    expect(unlisted.find((claim) => claim.id === "counterparties")).toMatchObject({
      status: "violated",
      witness: { operationId: "x" },
    });
  });

  it("catches fabricated declared balances and stays undecided without them", () => {
    const claims = evaluate();
    expect(claims.find((claim) => claim.id === "declared")).toMatchObject({ status: "violated" });

    const { expectedBalances, ...withoutDeclared } = JOURNAL;
    expect(expectedBalances).toBeDefined();
    const undecided = evaluate(withoutDeclared);
    expect(undecided.find((claim) => claim.id === "declared")).toMatchObject({ status: "undecided" });
  });

  it("proves a clean journal and builds a stable digest", () => {
    const clean = {
      ...JOURNAL,
      operations: [
        { id: "op-1", kind: "transfer", from: "agent", to: "merchant", amount: 400 },
        { id: "op-2", kind: "deposit", to: "agent", amount: 100 },
      ],
      expectedBalances: { agent: 700, merchant: 400 },
    };
    const claims = evaluate(clean);
    expect(claims.every((claim) => claim.status === "proved")).toBe(true);

    const at = new Date("2026-10-09T00:00:00Z");
    const report = buildEconomyReport(claims, parseJournal(JSON.stringify(clean)), { journal: "j.json", policy: null }, "test", at);
    const { digest, ...body } = report;
    expect(digest.value).toBe(createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"));
    expect(report.summary).toMatchObject({ proved: 5, violated: 0, undecided: 0 });
  });

  it("rejects malformed journals and policies", () => {
    expect(() => parseJournal("{}")).toThrow(LedgerError);
    expect(() => parseJournal(JSON.stringify({ journalVersion: "1", accounts: {}, operations: [{ kind: "teleport", amount: 1 }] }))).toThrow(/unsupported kind/);
    expect(() => parsePolicy(JSON.stringify({ policyVersion: "1", invariants: [] }))).toThrow(/at least one invariant/);
  });
});

describe("economy CLI", () => {
  it("exits 1 with witnesses and writes a digest-stamped artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "codebase-doctor-economy-"));
    temporaryRoots.push(root);
    const journalPath = join(root, "journal.json");
    const policyPath = join(root, "policy.json");
    const outPath = join(root, "report.json");
    writeFileSync(journalPath, JSON.stringify(JOURNAL), "utf8");
    writeFileSync(policyPath, JSON.stringify(POLICY), "utf8");

    const result = cli(["economy", "verify", journalPath, "--policy", policyPath, "--out", outPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("VIOLATED  no-overdraft");
    expect(result.stdout).toContain("witness: op-2");
    expect(result.stderr).toContain("economic report written");

    const report = JSON.parse(readFileSync(outPath, "utf8")) as { digest: { value: string } };
    const { digest, ...body } = report;
    expect(digest.value).toBe(createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"));
  });

  it("gates undecided invariants with --require-proved", () => {
    const root = mkdtempSync(join(tmpdir(), "codebase-doctor-economy-"));
    temporaryRoots.push(root);
    const journalPath = join(root, "journal.json");
    const { expectedBalances, ...withoutDeclared } = JOURNAL;
    expect(expectedBalances).toBeDefined();
    writeFileSync(journalPath, JSON.stringify(withoutDeclared), "utf8");

    const relaxed = cli(["economy", "verify", journalPath, "--json"]);
    expect(relaxed.status).toBe(1);

    const cleanPath = join(root, "clean.json");
    writeFileSync(cleanPath, JSON.stringify({
      ...withoutDeclared,
      operations: [{ id: "op-1", kind: "transfer", from: "agent", to: "merchant", amount: 400 }],
    }), "utf8");
    const clean = cli(["economy", "verify", cleanPath]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("UNDECIDED declared-balances");

    const strict = cli(["economy", "verify", cleanPath, "--require-proved"]);
    expect(strict.status).toBe(2);
  });
});
