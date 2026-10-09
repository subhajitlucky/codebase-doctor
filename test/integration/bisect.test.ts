import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  runGitFixtureCommand,
  writeProjectFile,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000 },
  );
}

const TOKEN = "ghp_7Qm2Xv9Kd4Rn8Ts3Lw6Yp1Bc5";

describe("bisect CLI", () => {
  it("finds the commit where a rule was introduced with parent-absence evidence", async () => {
    const root = await createTempProject("codebase-doctor-bisect-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    const cleanCommit = await commitInitialContent(root, {
      "src/config.ts": "export const config = { apiUrl: \"https://api.example.com\" };\n",
    });
    await writeProjectFile(root, "src/other.ts", "export const other = 2;\n");
    await runGitFixtureCommand(root, ["add", "--all"]);
    await runGitFixtureCommand(root, ["commit", "--quiet", "--message", "add helper"]);
    const helperCommit = (await runGitFixtureCommand(root, ["rev-parse", "HEAD^{commit}"])).trim();

    await writeProjectFile(
      root,
      "src/config.ts",
      `export const config = { apiUrl: "https://api.example.com" };\nexport const apiKey = "${TOKEN}";\n`,
    );
    await runGitFixtureCommand(root, ["add", "--all"]);
    await runGitFixtureCommand(root, ["commit", "--quiet", "--message", "agent adds config"]);
    const introducedCommit = (await runGitFixtureCommand(root, ["rev-parse", "HEAD^{commit}"])).trim();

    const result = cli(["bisect", "security/secrets/provider-token", root, "--json", "--max-commits", "50"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      found: boolean;
      evidence: { commit: string; parentCommit: string; message: string; location?: string };
    };
    expect(report.found).toBe(true);
    expect(report.evidence.commit).toBe(introducedCommit);
    expect(report.evidence.parentCommit).toBe(helperCommit);
    expect(helperCommit).not.toBe(cleanCommit);
    expect(report.evidence.message).toBe("agent adds config");
    expect(report.evidence.location).toBe("src/config.ts:2");
  }, 120_000);

  it("reports a clean not-found result without failing", async () => {
    const root = await createTempProject("codebase-doctor-bisect-none-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "src/index.ts": "export const value = 1;\n",
    });

    const result = cli(["bisect", "security/secrets/provider-token", root, "--max-commits", "10"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Not found");
  }, 120_000);

  it("fails operationally outside a git repository", async () => {
    const root = await createTempProject("codebase-doctor-bisect-nogit-");
    temporaryRoots.push(root);

    const result = cli(["bisect", "security/secrets/provider-token", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a git repository");
  }, 120_000);
});
