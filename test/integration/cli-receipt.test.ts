import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const fixture = resolve(repositoryRoot, "test", "fixtures", "node-fail");
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

describe("receipt CLI", () => {
  it("writes a receipt and verifies it end to end", () => {
    const root = mkdtempSync(join(tmpdir(), "codebase-doctor-receipt-"));
    temporaryRoots.push(root);
    const receiptPath = join(root, "receipt.json");

    const audit = cli(["audit", fixture, "--format", "brief", "--fail-on", "none", "--receipt", receiptPath]);
    expect(audit.status).toBe(0);
    expect(audit.stderr).toContain("receipt written");

    const verified = cli(["verify-receipt", receiptPath]);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain("integrity: digest verified");
    expect(verified.stdout).toContain("coverage: incomplete");
  });

  it("rejects a tampered receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "codebase-doctor-receipt-"));
    temporaryRoots.push(root);
    const receiptPath = join(root, "receipt.json");

    cli(["audit", fixture, "--format", "brief", "--fail-on", "none", "--receipt", receiptPath]);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { score: { value: number } };
    receipt.score.value = 100;
    writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");

    const verified = cli(["verify-receipt", receiptPath]);
    expect(verified.status).toBe(2);
    expect(verified.stderr).toContain("digest mismatch");
  });
});
