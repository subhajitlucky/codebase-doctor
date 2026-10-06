import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  removeTempProject,
  writeProjectFile,
} from "../helpers/temp-project.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];
const SECRET_ALPHABET = "M7n9B2v8C4x6Z1l3K5j0HgFdSaPqWeRt";

function generatedToken(prefix: string, length = 32): string {
  let value = prefix;
  for (let index = 0; value.length < prefix.length + length; index += 1) {
    value += SECRET_ALPHABET[index % SECRET_ALPHABET.length];
  }
  return value;
}

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
  );
}

async function createRepository(
  files: Readonly<Record<string, string>> = { "tracked.txt": "initial\n" },
): Promise<string> {
  const root = await createTempProject("codebase-doctor-cli-suppressions-");
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  await commitInitialContent(root, files);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempProject));
});

describe("suppressions CLI", () => {
  it("acknowledges a finding without gating or hiding it", { timeout: 30_000 }, async () => {
    const secret = generatedToken("ghp_");
    const root = await createRepository({
      "config.ts": `const API_KEY = "${secret}"; // codebase-doctor-ignore: security/secrets/provider-token -- rotated test credential\n`,
    });

    const brief = cli(["audit", root, "--format", "brief", "--fail-on", "high"]);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.stdout).toContain("suppressed: 1 finding(s) acknowledged");
    expect(brief.stdout).toContain("security/secrets/provider-token");
    expect(brief.stdout).toContain("rotated test credential");
    expect(brief.stdout).not.toContain(secret);

    const json = cli(["audit", root, "--format", "json", "--fail-on", "high"]);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.findings).toEqual([]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]).toMatchObject({
      ruleId: "security/secrets/provider-token",
      reason: "rotated test credential",
    });
    expect(json.stdout).not.toContain(secret);

    const text = cli(["audit", root, "--format", "text", "--fail-on", "none"]);
    expect(text.stdout).toContain("Suppressed findings");
    expect(text.stdout).toContain("never call them resolved");
  });

  it("keeps suppressed baseline findings unchanged instead of resolved", { timeout: 30_000 }, async () => {
    const secret = generatedToken("github_pat_");
    const root = await createRepository({
      "config.ts": `const API_KEY = "${secret}";\n`,
    });

    const before = cli(["audit", root, "--json", "--fail-on", "none"]);
    expect(before.status).toBe(0);
    const baselineReport = JSON.parse(before.stdout);
    expect(baselineReport.findings).toHaveLength(1);
    const fingerprint = baselineReport.findings[0].fingerprint as string;
    const baselinePath = `${root}/baseline.json`;
    writeFileSync(baselinePath, before.stdout);

    await writeProjectFile(
      root,
      "config.ts",
      `const API_KEY = "${secret}"; // codebase-doctor-ignore: security/secrets -- accepted risk\n`,
    );

    const after = cli(["audit", root, "--baseline", baselinePath, "--json"]);
    expect(after.status, after.stderr).toBe(0);
    const compared = JSON.parse(after.stdout);
    expect(compared.comparison.unchanged).toContain(fingerprint);
    expect(compared.comparison.resolved).toEqual([]);
    expect(compared.comparison.new).toEqual([]);

    const verify = cli(["verify", root, "--baseline", baselinePath, "--allow-unchanged"]);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain("unchanged=1");
    expect(verify.stdout).not.toContain("resolved=1");
  });

  it("ignores directives that match nothing and directives two lines away", { timeout: 30_000 }, async () => {
    const secret = generatedToken("xoxb-");
    const root = await createRepository({
      "config.ts": [
        "// codebase-doctor-ignore: security/secrets/provider-token",
        "",
        "",
        `const SLACK_TOKEN = "${secret}";\n`,
      ].join("\n"),
    });

    const result = cli(["audit", root, "--format", "brief", "--fail-on", "high"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("security/secrets/provider-token");
    expect(result.stdout).not.toContain("suppressed:");
  });
});
