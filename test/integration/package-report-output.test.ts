import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("package report output", () => {
  it("accepts lifecycle output before npm pack JSON", () => {
    const fakeNpmDirectory = join(repositoryRoot, "test", "fixtures", "noisy-npm");
    const result = spawnSync(process.execPath, ["scripts/check-package.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeNpmDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Verified codebase-doctor@0.1.1");
  });
});
