import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("benchmark harness", () => {
  it(
    "scores seeded fixtures end to end",
    { timeout: 300_000 },
    async () => {
      await execFileAsync("npm", ["run", "build"], {
        cwd: repositoryRoot,
        timeout: 300_000,
      });
      const output = await mkdtemp(join(tmpdir(), "codebase-doctor-bench-test-"));
      temporaryRoots.push(output);
      const reportPath = join(output, "results.json");

      const run = await execFileAsync(
        process.execPath,
        [
          resolve(repositoryRoot, "scripts", "benchmark.mjs"),
          "--cases",
          "secrets-tracked,review-approve",
          "--out",
          reportPath,
        ],
        { cwd: repositoryRoot, timeout: 300_000 },
      );

      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("2/2 cases passed");
      const { default: report } = await import(reportPath, { with: { type: "json" } }) as {
        default: { passed: number; total: number; cases: { name: string; pass: boolean }[] };
      };
      expect(report.passed).toBe(2);
      expect(report.total).toBe(2);
      expect(report.cases.every(({ pass }) => pass)).toBe(true);
    },
  );
});
