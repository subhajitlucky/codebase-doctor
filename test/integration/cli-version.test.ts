import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI version", () => {
  it("prints the package version", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--version"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.2");
  });
});
