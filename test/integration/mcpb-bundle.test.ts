import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function zipEntries(bundle: string): Promise<string[]> {
  const { stdout } = await execFileAsync("unzip", ["-Z1", bundle]);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

describe("mcpb bundle", () => {
  it("packs a self-contained bundle whose manifest matches the package", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebase-doctor-mcpb-test-"));
    temporaryRoots.push(root);
    const bundle = join(root, "codebase-doctor.mcpb");

    await execFileAsync("npm", ["run", "build"], { cwd: repositoryRoot, timeout: 300_000 });
    await execFileAsync(
      process.execPath,
      [resolve(repositoryRoot, "scripts", "build-mcpb.mjs"), "--out", bundle],
      { cwd: repositoryRoot, timeout: 300_000 },
    );

    const entries = await zipEntries(bundle);
    expect(entries).toContain("manifest.json");
    expect(entries).toContain("server/cli.js");
    expect(entries.some((entry) => entry.startsWith("server/node_modules/pg/"))).toBe(true);

    const { stdout: manifestText } = await execFileAsync(
      "unzip",
      ["-p", bundle, "manifest.json"],
    );
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { version: string };

    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: "codebase-doctor",
      version: packageJson.version,
      server: {
        type: "node",
        entry_point: "server/cli.js",
        mcp_config: { command: "node", args: ["${__dirname}/server/cli.js", "mcp"] },
      },
    });
  }, 300_000);
});
