import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFingerprint, type Finding } from "../../src/core/findings.js";
import { canonicalJson } from "../../src/receipts/receipt.js";
import { synthesizeWitness } from "../../src/witness/witness.js";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
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
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
  );
}

async function scratchRepo(files: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "codebase-doctor-witness-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, ...path.split("/")), content, "utf8");
  }
  return root;
}

function fabricatedFinding(ruleId: string, path: string, line: number): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity: "high",
    confidence: "high",
    category: "test",
    title: ruleId,
    message: ruleId,
    location: { path, line },
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({ doctorId: "fixture", ruleId, location: { path, line }, identity: ruleId }),
  };
}

describe("exploit witness synthesis", () => {
  it("synthesizes a SQL injection tautology", async () => {
    const root = await scratchRepo({
      "src/db.ts": [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "export function find(id: string) {",
        '  return pool.query("select * from users where id = \'" + id + "\'");',
        "}",
        "",
      ].join("\n"),
    });
    const outcome = await synthesizeWitness(
      root,
      fabricatedFinding("backend/api/sql-string-concat-query", "src/db.ts", 4),
      { toolVersion: "test", generatedAt: new Date("2026-10-09T00:00:00Z") },
    );

    expect(outcome.status).toBe("synthesized");
    if (outcome.status !== "synthesized") return;
    expect(outcome.artifact.witness.payload).toBe("' OR '1'='1' --");
    expect(outcome.artifact.witness.transformed).toBe(
      "select * from users where id = '' OR '1'='1' --'",
    );
    expect(outcome.artifact.witness.dynamicSegments).toBe(1);
    const { digest, ...body } = outcome.artifact;
    expect(digest.value).toBe(createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"));
  });

  it("handles template literals and TypeScript casts", async () => {
    const root = await scratchRepo({
      "src/run.ts": [
        'import { exec } from "node:child_process";',
        "export function run(name: string) {",
        "  return exec(`echo ${name as string}`);",
        "}",
        "",
      ].join("\n"),
    });
    const outcome = await synthesizeWitness(
      root,
      fabricatedFinding("backend/api/child-process-exec-dynamic", "src/run.ts", 3),
      { toolVersion: "test" },
    );

    expect(outcome.status).toBe("synthesized");
    if (outcome.status !== "synthesized") return;
    expect(outcome.artifact.witness.transformed).toBe("echo ; echo codebase-doctor-witness");
  });

  it("stays undecided for unsupported shapes and rules", async () => {
    const root = await scratchRepo({
      "src/run.ts": [
        'import { exec } from "node:child_process";',
        "export function run(flag: boolean, name: string) {",
        '  return exec(flag ? "echo safe" : name);',
        "}",
        "",
      ].join("\n"),
    });
    const conditional = await synthesizeWitness(
      root,
      fabricatedFinding("backend/api/child-process-exec-dynamic", "src/run.ts", 3),
      { toolVersion: "test" },
    );
    expect(conditional.status).toBe("undecided");
    if (conditional.status === "undecided") {
      expect(conditional.reason).toContain("unsupported expression type");
    }

    const unsupported = await synthesizeWitness(
      root,
      fabricatedFinding("repository/no-visible-tests", "src/run.ts", 3),
      { toolVersion: "test" },
    );
    expect(unsupported.status).toBe("undecided");
  });
});

describe("witness CLI", () => {
  it("writes a digest-bound witness artifact for a real finding", async () => {
    const root = await createTempProject("codebase-doctor-witness-cli-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "src/db.ts": [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "export function find(id: string) {",
        '  return pool.query("select * from users where id = \'" + id + "\'");',
        "}",
        "",
      ].join("\n"),
    });
    const audit = cli(["audit", root, "--json", "--fail-on", "none"]);
    const report = JSON.parse(audit.stdout) as { findings: { ruleId: string; fingerprint: string }[] };
    const fingerprint = report.findings.find(
      (finding) => finding.ruleId === "backend/api/sql-string-concat-query",
    )!.fingerprint;

    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-witness-work-"));
    temporaryRoots.push(workdir);
    const outPath = join(workdir, "witness.json");
    const result = cli(["witness", fingerprint, root, "--out", outPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Payload:     ' OR '1'='1' --");
    const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
      witness: { transformed: string };
      digest: { value: string };
    };
    expect(artifact.witness.transformed).toContain("' OR '1'='1' --");
    expect(artifact.digest.value).toHaveLength(64);
  }, 60_000);

  it("exits 2 for unknown fingerprints", async () => {
    const root = await createTempProject("codebase-doctor-witness-unknown-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, { "src/index.ts": "export const value = 1;\n" });

    const result = cli(["witness", "deadbeef", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No finding with fingerprint");
  }, 60_000);
});
