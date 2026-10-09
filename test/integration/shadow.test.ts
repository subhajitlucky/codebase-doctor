import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
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
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
  );
}

describe("shadow audits", () => {
  it("audits a disposable copy and marks the receipt as shadow", async () => {
    const root = await createTempProject("codebase-doctor-shadow-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "package.json": JSON.stringify({ name: "shadow-fixture", private: true }),
      "src/index.ts": "export const value = 1;\n",
    });
    const receiptRoot = mkdtempSync(join(tmpdir(), "codebase-doctor-shadow-receipt-"));
    temporaryRoots.push(receiptRoot);
    const receiptPath = join(receiptRoot, "receipt.json");

    const shadow = cli(["shadow", root, "--format", "brief", "--fail-on", "none", "--receipt", receiptPath]);
    expect(shadow.status).toBe(0);
    expect(shadow.stdout).toContain("Codebase Doctor Shadow Audit");
    expect(shadow.stdout).toContain("Shadow guarantees");

    const verified = cli(["verify-receipt", receiptPath]);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain("environment: shadow (disposable copy)");
  });

  it("keeps --run-checks side effects inside the copy", async () => {
    const root = await createTempProject("codebase-doctor-shadow-side-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "package.json": JSON.stringify({
        name: "shadow-side-effect",
        private: true,
        packageManager: "npm@11.0.0",
        scripts: {
          test: "node -e \"require('node:fs').writeFileSync('ran.txt','side effect')\"",
        },
      }),
    });

    const shadow = cli(["shadow", root, "--run-checks", "--fail-on", "none"]);
    expect(shadow.status).toBe(0);
    expect(shadow.stdout).toContain("Validation commands ran inside the copy");
    expect(shadow.stdout).toContain("Check: npm run test — passed");
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });

  it("does not create the receipt when none is requested", async () => {
    const root = await createTempProject("codebase-doctor-shadow-noreceipt-");
    temporaryRoots.push(root);
    await initializeGitRepository(root);
    await commitInitialContent(root, {
      "package.json": JSON.stringify({ name: "shadow-no-receipt", private: true }),
    });

    const shadow = cli(["shadow", root, "--fail-on", "none"]);
    expect(shadow.status).toBe(0);
    expect(shadow.stderr).not.toContain("receipt written");
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain("shadow-no-receipt");
  });
});
