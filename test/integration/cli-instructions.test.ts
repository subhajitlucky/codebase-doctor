import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 15_000 },
  );
}

describe("instructions CLI", () => {
  it("prints a single target with its destination file", () => {
    const result = cli(["instructions", "--target", "cursor"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# cursor → .cursor/rules/codebase-doctor.mdc");
    expect(result.stdout).toContain("alwaysApply: true");
    expect(result.stdout).toContain("verify . --baseline");
  });

  it("emits structured JSON for every target", () => {
    const result = cli(["instructions", "--json"]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      instructions: { target: string; file: string }[];
    };
    expect(parsed.instructions.length).toBeGreaterThanOrEqual(7);
    expect(parsed.instructions.map((snippet) => snippet.target)).toContain("mcp");
  });

  it("rejects invalid targets with exit 2", () => {
    const result = cli(["instructions", "--target", "vscode"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Invalid instruction target/u);
  });
});
