import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/receipts/receipt.js";
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
    { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000 },
  );
}

async function brokenImportRepo(extra: Record<string, string> = {}): Promise<string> {
  const root = await createTempProject("codebase-doctor-fix-");
  temporaryRoots.push(root);
  await initializeGitRepository(root);
  await commitInitialContent(root, {
    "src/helper.ts": "export function helper() { return 1; }\n",
    "src/app.ts": 'import { helper } from "./helpers.js";\nexport const value = helper();\n',
    ...extra,
  });
  return root;
}

function findingFingerprint(root: string): string {
  const audit = cli(["audit", root, "--json", "--fail-on", "none"]);
  expect(audit.status).toBe(0);
  const report = JSON.parse(audit.stdout) as { findings: { ruleId: string; fingerprint: string }[] };
  const finding = report.findings.find((entry) => entry.ruleId === "source/import-target-missing");
  expect(finding).toBeDefined();
  return finding!.fingerprint;
}

describe("fix CLI", () => {
  it("repairs a missing import with a verified git diff and a receipt", async () => {
    const root = await brokenImportRepo();
    const fingerprint = findingFingerprint(root);
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-fix-work-"));
    temporaryRoots.push(workdir);
    const patchPath = join(workdir, "fix.patch");
    const receiptPath = join(workdir, "fix.json");

    const result = cli(["fix", fingerprint, root, "--patch", patchPath, "--receipt", receiptPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verification: verified");
    expect(result.stdout).toContain('"./helpers.js" -> "./helper.js"');

    const patch = readFileSync(patchPath, "utf8");
    expect(patch).toContain('-import { helper } from "./helpers.js";');
    expect(patch).toContain('+import { helper } from "./helper.js";');

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      patch: { format: string; sha256: string };
      verification: { status: string; resolved: string[] };
      digest: { value: string };
    };
    expect(receipt.verification.status).toBe("verified");
    expect(receipt.verification.resolved).toHaveLength(1);
    expect(receipt.patch.format).toBe("git-diff");
    expect(receipt.patch.sha256).toBe(createHash("sha256").update(patch, "utf8").digest("hex"));
    const { digest, ...body } = receipt;
    expect(digest.value).toBe(createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"));

    // The original repository is never modified: the import is still broken.
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toContain("./helpers.js");
  }, 120_000);

  it("refuses ambiguous or missing candidates and unknown fingerprints", async () => {
    const ambiguous = await brokenImportRepo({
      "src/helper.tsx": "export function helper() { return 1; }\n",
    });
    const ambiguousFingerprint = findingFingerprint(ambiguous);
    const workdir = mkdtempSync(join(tmpdir(), "codebase-doctor-fix-work-"));
    temporaryRoots.push(workdir);
    const patchPath = join(workdir, "fix.patch");

    const ambiguousResult = cli(["fix", ambiguousFingerprint, ambiguous, "--patch", patchPath]);
    expect(ambiguousResult.status).toBe(2);
    expect(ambiguousResult.stderr).toContain("No unambiguous repair template applies");

    const missing = await createTempProject("codebase-doctor-fix-none-");
    temporaryRoots.push(missing);
    await initializeGitRepository(missing);
    await commitInitialContent(missing, {
      "src/app.ts": 'import { gone } from "./nowhere.js";\nexport const value = gone;\n',
    });
    const missingFingerprint = findingFingerprint(missing);
    const missingResult = cli(["fix", missingFingerprint, missing, "--patch", patchPath]);
    expect(missingResult.status).toBe(2);

    const unknown = cli(["fix", "deadbeef", ambiguous, "--patch", patchPath]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("No finding with fingerprint");
  }, 120_000);
});
