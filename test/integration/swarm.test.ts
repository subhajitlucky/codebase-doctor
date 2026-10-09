import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];
const TOKEN = "ghp_7Qm2Xv9Kd4Rn8Ts3Lw6Yp1Bc5";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000 },
  );
}

async function createSecretRepo(): Promise<string> {
  const root = await createTempProject("codebase-doctor-swarm-secret-");
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  await commitInitialContent(root, {
    "src/config.ts": `export const apiKey = "${TOKEN}";\n`,
  });
  return root;
}

async function createCleanRepo(): Promise<string> {
  const root = await createTempProject("codebase-doctor-swarm-clean-");
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  await commitInitialContent(root, {
    "package.json": JSON.stringify({ name: "swarm-clean", private: true }),
    "src/index.ts": "export const value = 1;\n",
  });
  return root;
}

describe("swarm CLI", () => {
  it("composes per-repo and fleet verdicts with receipts", async () => {
    const secret = await createSecretRepo();
    const clean = await createCleanRepo();
    const receiptDir = mkdtempSync(join(tmpdir(), "codebase-doctor-swarm-receipts-"));
    temporaryRoots.push(receiptDir);

    const result = cli(["swarm", secret, clean, "--json", "--receipt-dir", receiptDir]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      fleetVerdict: string;
      reports: { verdict: string; findings: number; error?: string }[];
    };
    expect(report.fleetVerdict).toBe("findings");
    expect(report.reports[0]?.verdict).toBe("findings");
    expect(report.reports[1]?.verdict).toBe("gaps");
    expect(report.reports.every((entry) => entry.error === undefined)).toBe(true);

    const receipts = cli(["verify-receipt", join(receiptDir, "01-" + secret.split("/").pop() + ".receipt.json")]);
    expect(receipts.status).toBe(0);
    expect(receipts.stdout).toContain("integrity: digest verified");
  }, 120_000);

  it("downgrades to gaps at --fail-on none and gates with --require-complete", async () => {
    const secret = await createSecretRepo();
    const clean = await createCleanRepo();

    const relaxed = cli(["swarm", secret, clean, "--fail-on", "none", "--json"]);
    expect(relaxed.status).toBe(0);
    const report = JSON.parse(relaxed.stdout) as { fleetVerdict: string };
    expect(report.fleetVerdict).toBe("gaps");

    const strict = cli(["swarm", secret, clean, "--fail-on", "none", "--require-complete"]);
    expect(strict.status).toBe(2);
    expect(strict.stdout).toContain("Exit code 2");
  }, 120_000);

  it("reports operational failures as unknown", async () => {
    const clean = await createCleanRepo();

    const result = cli(["swarm", clean, "/nonexistent/repo/path", "--json"]);
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout) as {
      fleetVerdict: string;
      reports: { verdict: string; error?: string }[];
    };
    expect(report.fleetVerdict).toBe("unknown");
    expect(report.reports[1]?.error).toBeDefined();
  }, 120_000);
});
