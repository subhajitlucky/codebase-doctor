import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const fixture = (name: string) => resolve(repositoryRoot, "test", "fixtures", name);

function cli(args: readonly string[], cwd = repositoryRoot) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd, encoding: "utf8", timeout: 15_000 },
  );
}

describe("scan CLI", () => {
  it("defaults to the current directory", () => {
    const cwd = fixture("node-pass");
    const result = cli(["scan", "--json"], cwd);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).repository.root).toBe(cwd);
  });

  it("accepts an explicit path and detects Python read-only", () => {
    const result = cli(["scan", fixture("python-detect"), "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.projects[0]).toMatchObject({
      ecosystems: ["python"],
      executionSupport: "supported",
    });
  });

  it("does not execute a failing fixture script by default", () => {
    const result = cli(["scan", fixture("node-fail"), "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings.some(({ ruleId }: { ruleId: string }) =>
      ruleId === "checks/command-failed",
    )).toBe(false);
    expect(report.doctorRuns.find(({ doctorId }: { doctorId: string }) =>
      doctorId === "checks",
    )).toMatchObject({ status: "skipped" });
  });

  it("executes configured checks only with --run-checks and exits 1", () => {
    const result = cli(["scan", fixture("node-fail"), "--run-checks", "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "checks/command-failed",
        severity: "high",
      }),
    ]));
  });

  it("preserves findings but exits 0 with --fail-on none", () => {
    const result = cli([
      "scan",
      fixture("node-fail"),
      "--run-checks",
      "--json",
      "--fail-on",
      "none",
    ]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings.some(({ ruleId }: { ruleId: string }) =>
      ruleId === "checks/command-failed",
    )).toBe(true);
  });

  it("returns exit 2 for a nonexistent path", () => {
    const result = cli(["scan", fixture("does-not-exist"), "--json"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/does not exist/i);
  });

  it.each([
    ["--timeout", "not-a-number"],
    ["--timeout", "0"],
    ["--fail-on", "urgent"],
  ])("returns exit 2 for invalid options: %s %s", (option, value) => {
    const result = cli(["scan", fixture("node-pass"), option, value]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/invalid/i);
  });

  it("shows each planned command and execution status in text mode", () => {
    const result = cli([
      "scan",
      fixture("node-pass"),
      "--run-checks",
      "--fail-on",
      "none",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Planned command: npm run test");
    expect(result.stdout).toContain("Check: npm run test — passed");
    expect(result.stdout.indexOf("Planned command: npm run test")).toBeLessThan(
      result.stdout.indexOf("Check: npm run test — passed"),
    );
  });
});
