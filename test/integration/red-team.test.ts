import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withRepositoryBuildLock } from "../helpers/repository-build.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("red-team harness", () => {
  it(
    "catches every mutant and keeps every control clean",
    { timeout: 300_000 },
    async () => {
      const output = await mkdtemp(join(tmpdir(), "codebase-doctor-redteam-test-"));
      temporaryRoots.push(output);
      const reportPath = join(output, "results.json");

      const run = await withRepositoryBuildLock(repositoryRoot, () =>
        execFileAsync(
          process.execPath,
          [resolve(repositoryRoot, "scripts", "red-team.mjs"), "--out", reportPath],
          { cwd: repositoryRoot, timeout: 300_000 },
        ),
      );

      expect(run.stderr).toBe("");
      expect(run.stdout).toContain("mutants caught");
      expect(run.stdout).toContain("controls clean");
      const { default: report } = await import(reportPath, { with: { type: "json" } }) as {
        default: {
          mutants: { total: number; caught: number };
          controls: { total: number; clean: number };
          results: { pass: boolean }[];
        };
      };
      expect(report.mutants.total).toBeGreaterThanOrEqual(10);
      expect(report.mutants.caught).toBe(report.mutants.total);
      expect(report.controls.clean).toBe(report.controls.total);
      expect(report.results.every(({ pass }) => pass)).toBe(true);
    },
  );
});
