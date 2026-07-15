import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

function run(executable: string, args: readonly string[], cwd = repositoryRoot) {
  return spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("release package", () => {
  it("passes the dry-run package contents contract", () => {
    const result = run(process.execPath, ["scripts/check-package.mjs"]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("installs the real tarball and runs its binary from a clean project", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "codebase-doctor-package-"));
    try {
      const packed = run("npm", [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
      ]);
      expect(packed.status, packed.stderr).toBe(0);
      const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];
      const tarball = join(temporaryRoot, filename);

      const installed = run("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ], temporaryRoot);
      expect(installed.status, installed.stderr).toBe(0);

      const binary = resolve(
        temporaryRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "codebase-doctor.cmd" : "codebase-doctor",
      );
      const scanned = run(binary, [
        "scan",
        resolve(repositoryRoot, "test", "fixtures", "node-pass"),
        "--json",
      ], temporaryRoot);

      expect(scanned.status, scanned.stderr).toBe(0);
      const report = JSON.parse(scanned.stdout);
      expect(report).toMatchObject({
        schemaVersion: "1",
        tool: { name: "codebase-doctor", version: "0.1.0" },
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
