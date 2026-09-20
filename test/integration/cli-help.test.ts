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

describe("codebase-doctor help", () => {
  it("shows the command list and exits 0 for --help", () => {
    const result = cli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: codebase-doctor [options] [command]");
    for (const command of ["audit", "scan", "verify", "instructions", "mcp"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("shows the same help and exits 0 when invoked without arguments", () => {
    const result = cli([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: codebase-doctor [options] [command]");
    expect(result.stdout).toContain("verify [options] [path]");
    expect(result.stderr).toBe("");
  });

  it("shows per-command help through the help command", () => {
    const result = cli(["help", "verify"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: codebase-doctor verify [options] [path]");
    expect(result.stdout).toContain("--allow-unchanged");
  });
});
