import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const fixture = (name: string) => resolve(repositoryRoot, "test", "fixtures", name);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  it("supports the format option while preserving the json alias", () => {
    const formatted = cli(["scan", fixture("node-pass"), "--format", "json"]);
    const aliased = cli(["scan", fixture("node-pass"), "--json"]);

    expect(formatted.status).toBe(0);
    expect(JSON.parse(formatted.stdout).schemaVersion).toBe("1");
    expect(JSON.parse(aliased.stdout).schemaVersion).toBe("1");
  });

  it("emits SARIF 2.1.0", () => {
    const result = cli(["scan", fixture("node-fail"), "--format", "sarif"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.version).toBe("2.1.0");
    expect(report.runs[0].tool.driver.name).toBe("Codebase Doctor");
  });

  it("rejects conflicting output options", () => {
    const result = cli(["scan", fixture("node-pass"), "--json", "--format", "text"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/conflict/i);
  });

  it("excludes matching projects before planning checks", () => {
    const result = cli(["scan", repositoryRoot, "--json", "--exclude", "test/fixtures/**"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.projects.map(({ root }: { root: string }) => root)).toEqual(["."]);
    expect(report.plannedChecks.every(({ projectId }: { projectId: string }) =>
      projectId === "root",
    )).toBe(true);
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

  it("uses a baseline so unchanged findings do not fail the scan", () => {
    const initial = cli([
      "scan", fixture("node-fail"), "--run-checks", "--json", "--fail-on", "none",
    ]);
    const root = mkdtempSync(resolve(tmpdir(), "codebase-doctor-baseline-"));
    temporaryRoots.push(root);
    const baseline = resolve(root, "baseline.json");
    writeFileSync(baseline, initial.stdout);

    const compared = cli([
      "scan", fixture("node-fail"), "--run-checks", "--json", "--baseline", baseline,
    ]);
    const report = JSON.parse(compared.stdout);

    expect(compared.status).toBe(0);
    expect(report.comparison.new).toEqual([]);
    expect(report.comparison.unchanged).toHaveLength(report.findings.length);
  });

  it("validates a baseline before permitting configured checks", () => {
    const root = mkdtempSync(resolve(tmpdir(), "codebase-doctor-consent-"));
    temporaryRoots.push(root);
    writeFileSync(resolve(root, "package.json"), JSON.stringify({
      private: true,
      packageManager: "npm@11.0.0",
      scripts: {
        test: "node -e \"require('node:fs').writeFileSync('executed', 'yes')\"",
      },
    }));
    writeFileSync(resolve(root, "invalid-baseline.json"), "not json");

    const result = cli([
      "scan", root, "--run-checks", "--baseline", resolve(root, "invalid-baseline.json"),
    ]);

    expect(result.status).toBe(2);
    expect(existsSync(resolve(root, "executed"))).toBe(false);
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
    ["--format", "xml"],
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
