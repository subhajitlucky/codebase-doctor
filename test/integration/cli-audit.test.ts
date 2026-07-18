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
const SECRET_ALPHABET = "M7n9B2v8C4x6Z1l3K5j0HgFdSaPqWeRt";

function generatedToken(prefix: string, length = 32): string {
  let value = prefix;
  for (let index = 0; value.length < prefix.length + length; index += 1) {
    value += SECRET_ALPHABET[index % SECRET_ALPHABET.length];
  }
  return value;
}

function npmGraphFiles(
  spec = "^1.0.0",
  resolved = "https://packages.example.invalid/alpha.tgz",
  integrity: string | undefined = "sha512-QUJDREVGRw==",
): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "dependency-fixture",
      private: true,
      packageManager: "npm@11.0.0",
      dependencies: { alpha: spec },
    }, null, 2),
    "package-lock.json": JSON.stringify({
      name: "dependency-fixture",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { alpha: spec } },
        "node_modules/alpha": {
          version: "1.0.0",
          resolved,
          ...(integrity === undefined ? {} : { integrity }),
        },
      },
    }, null, 2),
  };
}

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
  it("reports tracked env credentials but ignores a Git-ignored local env file", async () => {
    const trackedSecret = generatedToken("ghp_");
    const ignoredSecret = generatedToken("glpat-");
    const { root } = await createRepository({
      ".gitignore": ".env.local\n",
      ".env": `GITHUB_TOKEN=${trackedSecret}\n`,
      ".env.example": "GITHUB_TOKEN=your_key_here\n",
    });
    await writeProjectFile(root, ".env.local", `GITLAB_TOKEN=${ignoredSecret}\n`);
    const before = await captureGitRepositorySnapshot(root);

    const result = cli(["audit", root, "--json", "--fail-on", "none"], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings.filter(({ doctorId }: { doctorId: string }) =>
      doctorId === "security/secrets"
    )).toEqual([expect.objectContaining({
      ruleId: "security/secrets/provider-token",
      location: expect.objectContaining({ path: ".env", line: 1 }),
    })]);
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "security/secrets",
      status: "completed",
    }));
    expect(report.domainCoverage).toContainEqual(expect.objectContaining({
      domain: "security",
      applicability: "detected",
      status: "completed",
      coverageComplete: true,
      modules: [
        expect.objectContaining({
          moduleId: "security/dependencies",
          status: "not-applicable",
        }),
        expect.objectContaining({
          moduleId: "security/secrets",
          status: "completed",
        }),
      ],
    }));
    expect(result.stdout).not.toContain(trackedSecret);
    expect(result.stdout).not.toContain(ignoredSecret);
    expect(await captureGitRepositorySnapshot(root)).toEqual(before);
  });

  it("limits changed secret scanning to current changed files", async () => {
    const unchangedSecret = generatedToken("ghp_");
    const changedSecret = generatedToken("xoxb-");
    const { root } = await createRepository({
      "unchanged.ts": `const GITHUB_TOKEN = "${unchangedSecret}";\n`,
      "changed.ts": "export const value = 1;\n",
    });
    await writeProjectFile(root, "changed.ts", `const SLACK_TOKEN = "${changedSecret}";\n`);

    const result = cli([
      "audit", root, "--changed", "--json", "--fail-on", "none",
    ], root);
    const report = JSON.parse(result.stdout);
    const secretFindings = report.findings.filter(({ doctorId }: { doctorId: string }) =>
      doctorId === "security/secrets"
    );

    expect(result.status).toBe(0);
    expect(secretFindings).toEqual([expect.objectContaining({
      location: expect.objectContaining({ path: "changed.ts" }),
    })]);
    expect(result.stdout).not.toContain(unchangedSecret);
    expect(result.stdout).not.toContain(changedSecret);
  });

  it("applies the existing high-severity exit threshold to secret findings", async () => {
    const secret = generatedToken("github_pat_");
    const { root } = await createRepository({
      "config.ts": `const API_KEY = "${secret}";\n`,
    });

    const result = cli(["audit", root, "--json", "--fail-on", "high"], root);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(secret);
  });

  it("keeps text and SARIF secret findings redacted with matching coverage", async () => {
    const secret = generatedToken("glpat-");
    const { root } = await createRepository({
      "config.ts": `const GITLAB_TOKEN = "${secret}";\n`,
    });

    const text = cli(["audit", root, "--format", "text", "--fail-on", "none"], root);
    const sarif = cli(["audit", root, "--format", "sarif", "--fail-on", "none"], root);
    const sarifReport = JSON.parse(sarif.stdout);

    expect(text.status).toBe(0);
    expect(text.stdout).toContain("security/secrets");
    expect(text.stdout).not.toContain(secret);
    expect(sarif.status).toBe(0);
    expect(sarif.stdout).not.toContain(secret);
    expect(sarifReport.runs[0].results).toContainEqual(expect.objectContaining({
      ruleId: "security/secrets/provider-token",
    }));
    expect(sarifReport.runs[0].properties.domainCoverage).toContainEqual(
      expect.objectContaining({
        domain: "security",
        status: "completed",
        coverageComplete: true,
      }),
    );
  });

  it("accepts a consistent npm v3 graph with completed dependency coverage", async () => {
    const { root } = await createRepository(npmGraphFiles());
    const before = await captureGitRepositorySnapshot(root);

    const result = cli(["audit", root, "--json", "--fail-on", "none"], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings.filter(({ doctorId }: { doctorId: string }) =>
      doctorId === "security/dependencies"
    )).toEqual([]);
    expect(report.coverage).toContainEqual(expect.objectContaining({
      moduleId: "security/dependencies",
      status: "completed",
      scope: "full:.",
    }));
    expect(await captureGitRepositorySnapshot(root)).toEqual(before);
  });

  it("reports dependency drift, insecure transport, and missing integrity consistently", async () => {
    const seed = generatedToken("source-");
    const insecureSource = `http://user:${seed}@packages.example.invalid/alpha.tgz?token=${seed}`;
    const files = npmGraphFiles("^1.0.0", insecureSource);
    const lock = JSON.parse(files["package-lock.json"]!);
    lock.packages[""].dependencies.alpha = "^2.0.0";
    lock.packages["node_modules/beta"] = {
      version: "2.0.0",
      resolved: "https://packages.example.invalid/beta.tgz",
    };
    files["package-lock.json"] = JSON.stringify(lock, null, 2);
    const { root } = await createRepository(files);
    const before = await captureGitRepositorySnapshot(root);

    const json = cli(["audit", root, "--json", "--fail-on", "high"], root);
    const text = cli(["audit", root, "--format", "text", "--fail-on", "none"], root);
    const sarif = cli(["audit", root, "--format", "sarif", "--fail-on", "none"], root);
    const report = JSON.parse(json.stdout);
    const sarifReport = JSON.parse(sarif.stdout);
    const dependencyRules = report.findings
      .filter(({ doctorId }: { doctorId: string }) => doctorId === "security/dependencies")
      .map(({ ruleId }: { ruleId: string }) => ruleId);

    expect(json.status).toBe(1);
    expect(text.status).toBe(0);
    expect(sarif.status).toBe(0);
    expect(dependencyRules).toEqual(expect.arrayContaining([
      "security/dependencies/manifest-lock-drift",
      "security/dependencies/insecure-source",
      "security/dependencies/missing-integrity",
    ]));
    expect(text.stdout).toContain("security/dependencies");
    expect(sarifReport.runs[0].results).toContainEqual(expect.objectContaining({
      ruleId: "security/dependencies/insecure-source",
    }));
    expect(sarifReport.runs[0].properties.domainCoverage).toContainEqual(
      expect.objectContaining({ domain: "security", status: "completed" }),
    );
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr, sarif.stdout, sarif.stderr]) {
      expect(output).not.toContain(seed);
    }
    expect(await captureGitRepositorySnapshot(root)).toEqual(before);
  });

  it("audits the governing npm graph for an affected changed project", async () => {
    const { root } = await createRepository(npmGraphFiles());
    const seed = generatedToken("changed-source-");
    const insecureSource = `http://user:${seed}@packages.example.invalid/alpha.tgz`;
    const changedManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    changedManifest.dependencies.alpha = insecureSource;
    await writeProjectFile(root, "package.json", JSON.stringify(changedManifest, null, 2));

    const result = cli([
      "audit", root, "--changed", "--json", "--fail-on", "none",
    ], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings).toContainEqual(expect.objectContaining({
      doctorId: "security/dependencies",
      ruleId: "security/dependencies/insecure-source",
      location: { path: "package.json" },
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      moduleId: "security/dependencies",
      status: "completed",
      scope: "changed:.",
    }));
    expect(result.stdout).not.toContain(seed);
  });

  it("reports unsupported package managers as coverage, not findings", async () => {
    const { root } = await createRepository({
      "package.json": JSON.stringify({
        name: "pnpm-fixture",
        private: true,
        packageManager: "pnpm@10.0.0",
        dependencies: { alpha: "^1.0.0" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const result = cli(["audit", root, "--json", "--fail-on", "none"], root);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.findings.filter(({ doctorId }: { doctorId: string }) =>
      doctorId === "security/dependencies"
    )).toEqual([]);
    expect(report.coverage).toContainEqual(expect.objectContaining({
      moduleId: "security/dependencies",
      status: "unsupported",
      limitations: ["root: node:pnpm dependency metadata is not supported."],
    }));
    expect(report.domainCoverage).toContainEqual(expect.objectContaining({
      domain: "security",
      status: "partial",
      coverageComplete: false,
    }));
  });

  it("reports cross-project changed source impact in every format without mutation", async () => {
    const sourceCredential = generatedToken("import-source-");
    const { root } = await createRepository({
      "package.json": JSON.stringify({
        name: "source-impact-workspace",
        private: true,
        workspaces: ["packages/*", "apps/*"],
      }, null, 2),
      "packages/core/package.json": JSON.stringify({
        name: "@workspace/core",
        private: true,
        module: "src/value.ts",
      }, null, 2),
      "packages/core/src/value.ts": "export const value = 1;\n",
      "apps/web/package.json": JSON.stringify({
        name: "@workspace/web",
        private: true,
      }, null, 2),
      "apps/web/src/page.ts": [
        'import { value } from "@workspace/core";',
        `import "https://user:${sourceCredential}@example.invalid/external.js";`,
        "export const page = value;",
        "",
      ].join("\n"),
    });
    await writeProjectFile(root, "packages/core/src/value.ts", "export const value = 2;\n");
    const protectedPaths = [
      "package.json",
      "packages/core/package.json",
      "packages/core/src/value.ts",
      "apps/web/package.json",
      "apps/web/src/page.ts",
    ];
    const contentsBefore = new Map(protectedPaths.map((path) => [
      path,
      readFileSync(join(root, path), "utf8"),
    ]));
    const repositoryBefore = await captureGitRepositorySnapshot(root);

    const json = cli(["audit", root, "--changed", "--json", "--fail-on", "none"], root);
    const text = cli([
      "audit", root, "--changed", "--format", "text", "--fail-on", "none",
    ], root);
    const sarif = cli([
      "audit", root, "--changed", "--format", "sarif", "--fail-on", "none",
    ], root);
    const report = JSON.parse(json.stdout);
    const sarifReport = JSON.parse(sarif.stdout);

    expect(json.status, json.stderr).toBe(0);
    expect(text.status, text.stderr).toBe(0);
    expect(sarif.status, sarif.stderr).toBe(0);
    expect(report.sourceImpact).toMatchObject({
      mode: "changed",
      status: "completed",
      changedSourcePaths: ["packages/core/src/value.ts"],
      impactedFileCount: 1,
      impactedProjectIds: ["project:apps/web"],
      impacts: [{
        path: "apps/web/src/page.ts",
        projectId: "project:apps/web",
        dependencyPath: [
          "packages/core/src/value.ts",
          "apps/web/src/page.ts",
        ],
      }],
    });
    expect(report.auditScope.affectedProjectIds).toEqual(expect.arrayContaining([
      "project:apps/web",
      "project:packages/core",
    ]));
    expect(report.auditScope.reasons).toContainEqual(expect.objectContaining({
      projectId: "project:apps/web",
      reason: "source-dependent",
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      moduleId: "repository/source-graph",
      status: "completed",
      scope: "changed",
    }));
    expect(report.findings.filter(({ doctorId }: { doctorId: string }) =>
      doctorId === "repository/source-graph"
    )).toEqual([]);
    expect(text.stdout).toContain(
      "Impact: packages/core/src/value.ts -> apps/web/src/page.ts (project project:apps/web)",
    );
    expect(sarifReport.runs[0].properties.sourceImpact).toEqual(report.sourceImpact);
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr, sarif.stdout, sarif.stderr]) {
      expect(output).not.toContain(sourceCredential);
      expect(output).not.toContain("example.invalid");
    }
    expect(await captureGitRepositorySnapshot(root)).toEqual(repositoryBefore);
    for (const [path, contents] of contentsBefore) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(contents);
    }
  });

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
  ])("rejects a %s changed base safely", async (_label, base) => {
    const { root } = await createRepository();

    const result = cli([
      "audit", root, "--changed", "--base", base, "--json", "--fail-on", "none",
    ], root);

    expect(result.status).toBe(2);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stderr).toMatch(/^codebase-doctor: (?:.*base|git base)/im);
  });

  it.each([
    ["at the end of the command", []],
    ["before another option", ["--json", "--fail-on", "none"]],
  ])("rejects an omitted --base operand %s through the controlled error path", async (
    _position,
    trailingOptions,
  ) => {
    const { root } = await createRepository();

    const result = cli([
      "audit", root, "--changed", "--base", ...trailingOptions,
    ], root);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^codebase-doctor: .*--base.*(?:value|reference|empty)/im);
    expect(result.stderr).not.toMatch(/^error:/im);
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

  it("does not call an out-of-scope baseline finding resolved", async () => {
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
    expect(report.comparison.resolved).not.toContain(unsafeFinding.fingerprint);
    expect(report.comparison.resolved).toEqual([]);
    expect(report.comparison.newSummary.counts.high).toBe(0);
  });

  it("classifies in-scope findings and applies the threshold only to new findings", async () => {
    const migrationPath = "supabase/migrations/001_unsafe.sql";
    const initialMigration = [
      "create table public.accounts(id bigint primary key);",
      "grant select on public.accounts to anon;",
    ].join("\n");
    const { root } = await createRepository({ [migrationPath]: initialMigration });
    const baselineResult = cli([
      "audit", root, "--json", "--fail-on", "none",
    ], root);
    const baselinePath = join(root, "baseline.json");
    writeFileSync(baselinePath, baselineResult.stdout);
    await runGitFixtureCommand(root, ["add", "--", "baseline.json"]);
    await runGitFixtureCommand(root, ["commit", "--quiet", "--message", "add baseline"]);
    await writeProjectFile(root, migrationPath, `${initialMigration}\n-- reviewed\n`);

    const unchanged = cli([
      "audit", root, "--changed", "--baseline", baselinePath, "--json",
    ], root);
    const unchangedReport = JSON.parse(unchanged.stdout);
    const knownHigh = unchangedReport.findings.find(({ ruleId }: { ruleId: string }) =>
      ruleId === "database/sql-rls/rls-disabled-exposed"
    );

    expect(knownHigh).toBeDefined();
    expect(unchanged.status).toBe(0);
    expect(unchangedReport.comparison.unchanged).toContain(knownHigh.fingerprint);
    expect(unchangedReport.comparison.new).not.toContain(knownHigh.fingerprint);

    await writeProjectFile(root, "supabase/migrations/002_new_unsafe.sql", [
      "create table public.profiles(id bigint primary key);",
      "grant select on public.profiles to anon;",
    ].join("\n"));
    const withNewFinding = cli([
      "audit", root, "--changed", "--baseline", baselinePath, "--json",
    ], root);
    const newReport = JSON.parse(withNewFinding.stdout);
    const newHigh = newReport.findings.find((finding: { fingerprint: string; severity: string }) =>
      finding.severity === "high" && finding.fingerprint !== knownHigh.fingerprint
    );

    expect(newHigh).toBeDefined();
    expect(withNewFinding.status).toBe(1);
    expect(newReport.comparison.new).toContain(newHigh.fingerprint);
    expect(newReport.comparison.unchanged).toContain(knownHigh.fingerprint);
    expect(newReport.comparison.newSummary.counts.high).toBeGreaterThan(0);
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
