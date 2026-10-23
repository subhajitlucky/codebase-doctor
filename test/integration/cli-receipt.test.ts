import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
} from "../helpers/temp-project.js";

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

  it("binds an audit receipt to the repository HEAD", async () => {
    const root = await createTempProject("codebase-doctor-receipt-git-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    const commit = await commitInitialContent(root, {
      "package.json": JSON.stringify({ name: "receipt-git", private: true }),
      "src/index.ts": "export const value = 1;\n",
    });
    const receiptPath = join(root, "receipt.json");

    const audit = cli(["audit", root, "--format", "brief", "--fail-on", "none", "--receipt", receiptPath]);
    expect(audit.status, audit.stderr).toBe(0);

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      subject: { commit: string; baseCommit: string | null; changedPaths: number; changesDigest: string };
    };
    expect(receipt.subject.commit).toBe(commit);
    expect(receipt.subject.baseCommit).toBeNull();
    expect(receipt.subject.changedPaths).toBe(0);
    expect(receipt.subject.changesDigest).toMatch(/^[0-9a-f]{64}$/u);

    const verified = cli(["verify-receipt", receiptPath]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain(`commit=${commit}`);
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
