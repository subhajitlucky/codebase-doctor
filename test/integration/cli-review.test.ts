import { spawnSync } from "node:child_process";
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
  const root = await createTempProject("codebase-doctor-cli-review-");
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  await commitInitialContent(root, files);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempProject));
});

describe("review CLI", () => {
  it("requests changes with markdown for a secret on an added line", { timeout: 30_000 }, async () => {
    const secret = generatedToken("ghp_");
    const root = await createRepository({ "ok.ts": "export const value = 1;\n" });
    await writeProjectFile(root, "changed.ts", `const GITHUB_TOKEN = "${secret}";\n`);

    const result = cli(["review", root, "--format", "markdown", "--fail-on", "high"]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("## Codebase Doctor Review — 🔴 REQUEST_CHANGES");
    expect(result.stdout).toContain("findings in diff: 1");
    expect(result.stdout).toContain("security/secrets/provider-token");
    expect(result.stdout).toContain("`changed.ts:1");
    expect(result.stdout).toContain("### Coverage limitations");
    expect(result.stdout).not.toContain(secret);
  });

  it("approves when the only finding sits on an unchanged line", { timeout: 30_000 }, async () => {
    const secret = generatedToken("ghp_");
    const root = await createRepository({
      "app.ts": `const GITHUB_TOKEN = "${secret}";\nexport const value = 1;\n`,
    });
    await writeProjectFile(
      root,
      "app.ts",
      `const GITHUB_TOKEN = "${secret}";\nexport const value = 2;\n`,
    );

    const review = cli(["review", root, "--format", "markdown", "--fail-on", "high"]);
    const audit = cli(["audit", root, "--changed", "--format", "brief", "--fail-on", "none"]);

    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toContain("🟢 APPROVE");
    expect(review.stdout).toContain("findings in diff: 0");
    expect(review.stdout).not.toContain(secret);
    expect(audit.stdout).toContain("security/secrets/provider-token");

    const all = cli([
      "review", root, "--format", "brief", "--fail-on", "high", "--all-findings",
    ]);
    expect(all.status).toBe(1);
    expect(all.stdout).toContain("security/secrets/provider-token");
  });

  it("emits workflow commands and a review envelope in json", { timeout: 30_000 }, async () => {
    const secret = generatedToken("xoxb-");
    const root = await createRepository({ "ok.ts": "export const value = 1;\n" });
    await writeProjectFile(root, "changed.ts", `const SLACK_TOKEN = "${secret}";\n`);

    const github = cli(["review", root, "--format", "github", "--fail-on", "high"]);
    expect(github.status).toBe(1);
    expect(github.stdout).toMatch(/^::error file=changed\.ts,line=1,/m);
    expect(github.stdout).toContain("verdict=REQUEST_CHANGES");
    expect(github.stdout).not.toContain(secret);

    const json = cli(["review", root, "--format", "json", "--fail-on", "high"]);
    expect(json.status).toBe(1);
    const report = JSON.parse(json.stdout);
    expect(report.review).toMatchObject({
      verdict: "REQUEST_CHANGES",
      findingsInDiff: 1,
      totalFindings: 1,
      linePrecision: true,
    });
    expect(report.findings).toHaveLength(1);
    expect(json.stdout).not.toContain(secret);
  });

  it("comments below the threshold and approves a clean diff", { timeout: 30_000 }, async () => {
    const secret = generatedToken("xoxb-");
    const root = await createRepository({ "ok.ts": "export const value = 1;\n" });
    await writeProjectFile(root, "changed.ts", `const SLACK_TOKEN = "${secret}";\n`);

    const comment = cli(["review", root, "--format", "text", "--fail-on", "critical"]);
    expect(comment.status).toBe(0);
    expect(comment.stdout).toContain("Review verdict: COMMENT");

    await writeProjectFile(root, "changed.ts", "export const value = 3;\n");
    const clean = cli(["review", root, "--format", "brief", "--fail-on", "high"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("APPROVE");
  });

  it("fails new findings only when a baseline is provided", { timeout: 30_000 }, async () => {
    const secret = generatedToken("ghp_");
    const root = await createRepository({
      "known.ts": `const GITHUB_TOKEN = "${secret}";\n`,
    });
    const baseline = cli(["audit", root, "--json", "--fail-on", "none"]);
    const baselinePath = `${root}/baseline.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(baselinePath, baseline.stdout);

    const unchanged = cli([
      "review", root, "--format", "brief", "--baseline", baselinePath,
    ]);
    expect(unchanged.status, unchanged.stderr).toBe(0);

    const fresh = generatedToken("xoxb-");
    await writeProjectFile(root, "fresh.ts", `const SLACK_TOKEN = "${fresh}";\n`);
    const withNew = cli([
      "review", root, "--format", "brief", "--baseline", baselinePath,
    ]);
    expect(withNew.status).toBe(1);
    expect(withNew.stdout).toContain("REQUEST_CHANGES");
  });

  it("writes a signed, verifiable review receipt without leaking secrets", { timeout: 30_000 }, async () => {
    const secret = generatedToken("ghp_");
    const root = await createRepository({ "ok.ts": "export const value = 1;\n" });
    await writeProjectFile(root, "changed.ts", `const GITHUB_TOKEN = "${secret}";\n`);

    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ed25519");
    const keyPath = `${root}/receipt-key.pem`;
    const receiptPath = `${root}/proof/review.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());

    const review = cli([
      "review", root, "--format", "brief", "--fail-on", "high",
      "--receipt", receiptPath, "--receipt-key", keyPath,
    ]);
    expect(review.status, review.stderr).toBe(1);
    expect(review.stderr).toContain("receipt written");

    const raw = (await import("node:fs")).readFileSync(receiptPath, "utf8");
    expect(raw).not.toContain(secret);
    const receipt = JSON.parse(raw);
    expect(receipt.review).toMatchObject({
      verdict: "REQUEST_CHANGES",
      excludedCount: 0,
      linePrecision: true,
      allFindings: false,
      baselineFiltered: false,
    });
    expect(receipt.review.findingsInDiff).toBeGreaterThan(0);
    expect(receipt.findings.total).toBe(receipt.review.findingsInDiff);
    expect(receipt.review.totalFindings).toBe(
      receipt.review.findingsInDiff + receipt.review.excludedCount,
    );
    expect(receipt.subject.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(receipt.signature.algorithm).toBe("ed25519");

    const verified = cli(["verify-receipt", receiptPath]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("review: REQUEST_CHANGES");
    expect(verified.stdout).toContain("signature: ed25519");
  });

  it("never labels an empty checkout as approved", { timeout: 30_000 }, async () => {
    const root = await createRepository({ "ok.ts": "export const value = 1;\n" });

    const review = cli(["review", root, "--format", "brief", "--fail-on", "high"]);
    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toContain("NO_CHANGES");
    expect(review.stdout).not.toContain("APPROVE");

    const required = cli(["review", root, "--format", "brief", "--require-base"]);
    expect(required.status).toBe(2);
    expect(required.stderr).toContain("--require-base requires --base");
  });

  it("rejects unknown review formats and writes reports to --output", { timeout: 30_000 }, async () => {
    const root = await createRepository();

    const bad = cli(["review", root, "--format", "junit"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/invalid review output format/i);

    const outputPath = `${root}/reports/review.md`;
    const ok = cli(["review", root, "--format", "markdown", "--output", outputPath]);
    expect(ok.status, ok.stderr).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(outputPath, "utf8")).toBe(ok.stdout);
  });
});
