import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeDatabaseSchemas,
  parseDatabaseTimeout,
} from "../../src/commands/audit.js";
import {
  captureGitRepositorySnapshot,
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  removeTempProject,
  runGitFixtureCommand,
  writeProjectFile,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const fixture = (name: string) => resolve(repositoryRoot, "test", "fixtures", name);
const temporaryRoots: string[] = [];

function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: "",
    SUPABASE_DB_URL: "",
  };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_CONFIG_")) delete environment[name];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = join(root, ".codebase-doctor-empty-global-config");
  return environment;
}

function cli(args: readonly string[], gitRoot = repositoryRoot) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: isolatedGitEnvironment(gitRoot),
    },
  );
}

async function createRepository(
  files: Readonly<Record<string, string>> = { "tracked.txt": "initial\n" },
): Promise<{ root: string; initialCommit: string }> {
  const root = await createTempProject("codebase-doctor-cli-audit-changed-");
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  const initialCommit = await commitInitialContent(root, files);
  return { root, initialCommit };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempProject));
});

describe("audit CLI", () => {
  it("reports staged, unstaged, and untracked changes from HEAD without mutating the repository", async () => {
    const { root, initialCommit } = await createRepository({
      "staged.txt": "initial\n",
      "unstaged.txt": "initial\n",
    });
    await writeProjectFile(root, "staged.txt", "staged change\n");
    await runGitFixtureCommand(root, ["add", "--", "staged.txt"]);
    await writeProjectFile(root, "unstaged.txt", "unstaged change\n");
    await writeProjectFile(root, "untracked.txt", "untracked\n");
    const before = await captureGitRepositorySnapshot(root);
    const contentsBefore = readFileSync(join(root, "unstaged.txt"), "utf8");

    const result = cli([
      "audit", root, "--changed", "--json", "--fail-on", "none",
    ], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.auditScope).toMatchObject({
      mode: "changed",
      base: { kind: "head", requestedRef: null, resolvedCommit: initialCommit },
      changes: [
        { status: "modified", path: "staged.txt" },
        { status: "modified", path: "unstaged.txt" },
        { status: "untracked", path: "untracked.txt" },
      ],
    });
    expect(await captureGitRepositorySnapshot(root)).toEqual(before);
    expect(readFileSync(join(root, "unstaged.txt"), "utf8")).toBe(contentsBefore);
  });

  it("uses the requested merge base and includes committed plus current changes", async () => {
    const { root, initialCommit } = await createRepository({
      "staged.txt": "initial\n",
      "unstaged.txt": "initial\n",
    });
    await runGitFixtureCommand(root, ["branch", "-M", "main"]);
    await runGitFixtureCommand(root, ["switch", "-c", "feature"]);
    await writeProjectFile(root, "committed.txt", "branch change\n");
    await runGitFixtureCommand(root, ["add", "--", "committed.txt"]);
    await runGitFixtureCommand(root, ["commit", "--quiet", "--message", "branch change"]);
    await writeProjectFile(root, "staged.txt", "staged change\n");
    await runGitFixtureCommand(root, ["add", "--", "staged.txt"]);
    await writeProjectFile(root, "unstaged.txt", "unstaged change\n");
    await writeProjectFile(root, "untracked.txt", "untracked\n");

    const result = cli([
      "audit", root, "--changed", "--base", "main", "--json", "--fail-on", "none",
    ], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.auditScope).toMatchObject({
      mode: "changed",
      base: {
        kind: "merge-base",
        requestedRef: "main",
        resolvedCommit: initialCommit,
      },
      changes: [
        { status: "added", path: "committed.txt" },
        { status: "modified", path: "staged.txt" },
        { status: "modified", path: "unstaged.txt" },
        { status: "untracked", path: "untracked.txt" },
      ],
    });
  });

  it("rejects --base without --changed before baseline loading or configured checks", async () => {
    const { root } = await createRepository({
      "package.json": JSON.stringify({
        private: true,
        packageManager: "npm@11.0.0",
        scripts: {
          test: "node -e \"require('node:fs').writeFileSync('executed', 'yes')\"",
        },
      }),
    });
    writeFileSync(join(root, "invalid-baseline.json"), "not json");

    const result = cli([
      "audit", root, "--base", "main", "--run-checks", "--baseline",
      join(root, "invalid-baseline.json"),
    ], root);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^codebase-doctor: .*--base.*--changed/im);
    expect(result.stderr).not.toMatch(/baseline.*valid json/i);
    expect(existsSync(join(root, "executed"))).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "  "],
    ["missing", "does-not-exist"],
  ])("rejects an %s changed base safely", async (_label, base) => {
    const { root } = await createRepository();

    const result = cli([
      "audit", root, "--changed", "--base", base, "--json", "--fail-on", "none",
    ], root);

    expect(result.status).toBe(2);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stderr).toMatch(/^codebase-doctor: .*base|git base/im);
  });

  it("rejects changed mode outside Git", async () => {
    const root = await createTempProject("codebase-doctor-cli-audit-not-git-");
    temporaryRoots.push(root);
    await writeProjectFile(root, "package.json", JSON.stringify({ private: true }));

    const result = cli([
      "audit", root, "--changed", "--json", "--fail-on", "none",
    ], root);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/git repository/i);
  });

  it("does not grant check execution or live database access in changed mode", async () => {
    const { root } = await createRepository({
      "package.json": JSON.stringify({
        private: true,
        packageManager: "npm@11.0.0",
        scripts: {
          test: "node -e \"require('node:fs').writeFileSync('executed', 'yes')\"",
        },
      }),
    });
    await writeProjectFile(root, "changed.txt", "changed\n");

    const result = cli([
      "audit", root, "--changed", "--json", "--fail-on", "none",
    ], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.plannedChecks).not.toHaveLength(0);
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "checks",
      status: "skipped",
    }));
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/rls",
      status: "skipped",
      skipReason: expect.stringContaining("network:access"),
    }));
    expect(existsSync(join(root, "executed"))).toBe(false);
  });

  it("compares only findings produced by changed scope against a baseline", async () => {
    const { root } = await createRepository({
      "supabase/migrations/001_unsafe.sql": [
        "create table public.accounts(id bigint primary key);",
        "grant select on public.accounts to anon;",
      ].join("\n"),
    });
    const baselineResult = cli([
      "audit", root, "--json", "--fail-on", "none",
    ], root);
    const baselineReport = JSON.parse(baselineResult.stdout);
    const unsafeFinding = baselineReport.findings.find(({ ruleId }: { ruleId: string }) =>
      ruleId === "database/sql-rls/rls-disabled-exposed"
    );
    const baselinePath = join(root, "baseline.json");
    writeFileSync(baselinePath, baselineResult.stdout);
    await runGitFixtureCommand(root, ["add", "--", "baseline.json"]);
    await runGitFixtureCommand(root, ["commit", "--quiet", "--message", "add baseline"]);
    await writeProjectFile(root, "README.md", "documentation only\n");

    const result = cli([
      "audit", root, "--changed", "--baseline", baselinePath, "--json",
    ], root);
    const report = JSON.parse(result.stdout);

    expect(unsafeFinding).toBeDefined();
    expect(result.status).toBe(0);
    expect(report.findings).not.toContainEqual(expect.objectContaining({
      ruleId: "database/sql-rls/rls-disabled-exposed",
    }));
    expect(report.comparison.resolved).toContain(unsafeFinding.fingerprint);
    expect(report.comparison.newSummary.counts.high).toBe(0);
  });

  it.each([
    ["text", "Codebase Doctor"],
    ["json", '"auditScope"'],
    ["sarif", '"version": "2.1.0"'],
  ])("keeps %s output selectable in changed mode", async (format, marker) => {
    const { root } = await createRepository();
    await writeProjectFile(root, "changed.txt", "changed\n");

    const result = cli([
      "audit", root, "--changed", "--format", format, "--fail-on", "none",
    ], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(marker);
  });

  it("finds unsafe Supabase migration state without database credentials", () => {
    const result = cli([
      "audit", fixture("sql-rls/unsafe"), "--json", "--fail-on", "none",
    ]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings).toContainEqual(expect.objectContaining({
      doctorId: "database/sql-rls",
      ruleId: "database/sql-rls/rls-disabled-exposed",
      severity: "high",
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      moduleId: "database/sql-rls",
      scope: "root:supabase/migrations",
      status: "completed",
    }));
  });

  it("accepts a safe Prisma migration stream without high findings", () => {
    const result = cli(["audit", fixture("sql-rls/safe"), "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.coverage).toContainEqual(expect.objectContaining({
      scope: "root:prisma/migrations",
      status: "completed",
    }));
    expect(report.findings.filter(({ doctorId }: { doctorId: string }) =>
      doctorId === "database/sql-rls"
    )).toEqual([]);
  });

  it("reports dynamic migration SQL as partial coverage", () => {
    const result = cli(["audit", fixture("sql-rls/partial"), "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.coverage).toContainEqual(expect.objectContaining({
      scope: "root:migrations",
      status: "partial",
      statementsExamined: 1,
      statementsRecognized: 0,
      limitations: expect.arrayContaining([expect.stringMatching(/dynamic do blocks/i)]),
    }));
  });

  it("combines repository auditing with visible skipped database coverage", () => {
    const result = cli(["audit", fixture("node-pass"), "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/rls",
      status: "skipped",
      skipReason: expect.stringContaining("network:access"),
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      moduleId: "database/sql-rls",
      status: "not-applicable",
    }));
  });

  it("fails requested database coverage when credentials are missing", () => {
    const result = cli(["audit", fixture("node-pass"), "--with-database", "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(2);
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/rls",
      status: "failed",
      error: expect.objectContaining({ message: expect.stringMatching(/DATABASE_URL/) }),
    }));
  });

  it("accepts repeatable database schemas without enabling a connection", () => {
    const result = cli([
      "audit",
      fixture("node-pass"),
      "--database-schema",
      "public",
      "--database-schema",
      "private",
      "--json",
    ]);

    expect(result.status).toBe(0);
  });

  it.each([
    ["--database-timeout", "zero"],
    ["--database-timeout", "0"],
    ["--database-schema", ""],
  ])("rejects invalid database option %s %s", (option, value) => {
    const result = cli(["audit", fixture("node-pass"), option, value]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/database|schema|timeout|invalid/i);
  });

  it("does not expose a connection-string CLI option", () => {
    const result = cli([
      "audit",
      fixture("node-pass"),
      "--connection",
      "postgres://audit:secret@db.test/app",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option.*--connection/i);
  });
});

describe("database option normalization", () => {
  it("defaults, trims, and deduplicates schemas", () => {
    expect(normalizeDatabaseSchemas([])).toEqual(["public"]);
    expect(normalizeDatabaseSchemas([" public ", "private", "public"])).toEqual([
      "public",
      "private",
    ]);
  });

  it("parses a bounded positive timeout", () => {
    expect(parseDatabaseTimeout("10000")).toBe(10_000);
    expect(() => parseDatabaseTimeout("0")).toThrow(/timeout/i);
  });
});
