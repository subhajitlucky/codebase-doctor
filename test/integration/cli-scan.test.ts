import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  runGitFixtureCommand,
  writeProjectFile,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const fixture = (name: string) => resolve(repositoryRoot, "test", "fixtures", name);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_CONFIG_")) delete environment[name];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = join(root, ".codebase-doctor-empty-global-config");
  return environment;
}

function cli(args: readonly string[], cwd = repositoryRoot, gitRoot = cwd) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd, encoding: "utf8", timeout: 15_000, env: isolatedGitEnvironment(gitRoot) },
  );
}

describe("scan CLI", () => {
  it("exposes changed scope with an explicit merge-base ref", async () => {
    const root = await createTempProject("codebase-doctor-cli-scan-changed-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    const initialCommit = await commitInitialContent(root, {
      "package.json": JSON.stringify({ private: true }),
    });
    await runGitFixtureCommand(root, ["branch", "main"]);
    await writeProjectFile(root, "changed.txt", "changed\n");

    const result = cli([
      "scan", root, "--changed", "--base", "main", "--json", "--fail-on", "none",
    ], repositoryRoot, root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.auditScope).toMatchObject({
      mode: "changed",
      base: {
        kind: "merge-base",
        requestedRef: "main",
        resolvedCommit: initialCommit,
      },
      changes: [{ status: "untracked", path: "changed.txt" }],
    });
  });

  it("rejects an omitted --base operand through the controlled error path", async () => {
    const root = await createTempProject("codebase-doctor-cli-scan-base-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root);

    const result = cli([
      "scan", root, "--changed", "--base", "--json", "--fail-on", "none",
    ], repositoryRoot, root);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^codebase-doctor: .*--base.*(?:value|reference|empty)/im);
    expect(result.stderr).not.toMatch(/^error:/im);
  });

  it("runs repository source coverage without database audit modules", () => {
    const result = cli(["scan", fixture("sql-rls/unsafe"), "--json"]);
    const report = JSON.parse(result.stdout);
    const doctorIds = report.doctorRuns.map(({ doctorId }: { doctorId: string }) => doctorId);

    expect(result.status).toBe(0);
    expect(doctorIds).not.toContain("database/sql-rls");
    expect(doctorIds).not.toContain("database/rls");
    expect(report.coverage).toEqual([
      expect.objectContaining({
        moduleId: "ai/agent-surface",
        scope: "full",
      }),
      expect.objectContaining({
        moduleId: "repository/source-graph",
        scope: "full",
      }),
      expect.objectContaining({
        moduleId: "repository/source-integrity",
        scope: "full",
      }),
    ]);
  });

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

  it("gates exit code on incomplete coverage with --require-complete", async () => {
    const root = await createTempProject("codebase-doctor-require-complete-");
    temporaryRoots.push(root);
    await writeProjectFile(root, "package.json", JSON.stringify({ private: true }));

    const tolerant = cli(["scan", root, "--json", "--fail-on", "none"], repositoryRoot, root);
    expect(tolerant.status).toBe(0);

    const strict = cli(
      ["scan", root, "--json", "--fail-on", "none", "--require-complete"],
      repositoryRoot,
      root,
    );
    expect(strict.status).toBe(2);
    expect(strict.stderr).toMatch(/coverage is incomplete/i);
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

  it("renders bounded brief output with scope and coverage", () => {
    const result = cli([
      "scan",
      fixture("node-fail"),
      "--format",
      "brief",
      "--fail-on",
      "none",
      "--max-findings",
      "2",
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("codebase-doctor brief");
    expect(lines[1]).toMatch(/^scope=full findings=\d+ shown=\d+ coverage=(complete|incomplete)$/u);
    expect(result.stdout).toMatch(/\[(info|low|medium|high|critical)\] \S+ /u);
  });

  it("verifies a saved baseline and reports unchanged findings", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "codebase-doctor-verify-"));
    temporaryRoots.push(directory);
    const baselinePath = join(directory, "baseline.json");

    const saved = cli(["audit", fixture("node-fail"), "--json", "--fail-on", "none"]);
    expect(saved.status).toBe(0);
    writeFileSync(baselinePath, saved.stdout, "utf8");

    const verified = cli([
      "verify",
      fixture("node-fail"),
      "--baseline",
      baselinePath,
      "--json",
      "--fail-on",
      "none",
    ]);
    expect(verified.status).toBe(1);
    const verification = JSON.parse(verified.stdout) as {
      counts: Record<string, number>;
      coverageLimitations: string[];
      baseline: unknown[];
    };
    expect(verification.baseline.length).toBeGreaterThan(0);
    expect(verification.counts.unchanged).toBeGreaterThan(0);
    expect(verification.counts.resolved).toBe(0);

    const allowed = cli([
      "verify",
      fixture("node-fail"),
      "--baseline",
      baselinePath,
      "--fail-on",
      "none",
      "--allow-unchanged",
    ]);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain("Codebase Doctor Verify");
  });

  it("requires a baseline for verify", () => {
    const result = cli(["verify", fixture("node-pass")]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--baseline/u);
  });
});
