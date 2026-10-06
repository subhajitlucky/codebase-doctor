import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

function outputPath() {
  const flagIndex = process.argv.indexOf("--out");
  const value = flagIndex === -1 ? undefined : process.argv[flagIndex + 1];
  if (flagIndex !== -1 && (value === undefined || value.length === 0)) {
    throw new Error("build-mcpb: --out requires a file path.");
  }
  return resolve(repositoryRoot, value ?? "codebase-doctor.mcpb");
}

async function manifest() {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  return {
    manifest_version: "0.3",
    name: "codebase-doctor",
    display_name: "Codebase Doctor",
    version: manifest.version,
    description:
      "Evidence-backed, read-only codebase diagnostics for coding agents: " +
      "audit, review, and verify repositories without writes or network access by default.",
    author: { name: manifest.author },
    repository: { type: "git", url: "git+https://github.com/subhajitlucky/codebase-doctor.git" },
    homepage: manifest.homepage,
    license: manifest.license,
    keywords: manifest.keywords.filter((keyword) =>
      ["code-review", "diagnostics", "static-analysis", "code-audit", "security"].includes(keyword)
    ),
    server: {
      type: "node",
      entry_point: "server/cli.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/cli.js", "mcp"],
      },
    },
    tools: [
      {
        name: "audit_codebase",
        description: "Run the full built-in audit on a repository and return the evidence-backed report.",
      },
      {
        name: "review_changes",
        description: "Review changed code with a PR-ready verdict narrowed to added diff lines.",
      },
      {
        name: "verify_changes",
        description: "Verify that baseline findings were repaired under completed coverage.",
      },
      {
        name: "explain_finding",
        description: "Return full evidence and remediation guidance for one finding.",
      },
      {
        name: "describe_capabilities",
        description: "Describe server tools, audit domains, and never-granted permissions.",
      },
    ],
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: ">=20.0.0" },
    },
  };
}

/**
 * Pack the built CLI into an MCPB bundle for Smithery local distribution.
 * dist/ keeps runtime imports (pg, commander, ...) external, so production
 * node_modules are installed into a disposable prefix and bundled alongside.
 * Usage: node scripts/build-mcpb.mjs [--out <file>]. Run npm run build first.
 */
async function main() {
  const out = outputPath();
  const staging = await mkdtemp(join(tmpdir(), "codebase-doctor-mcpb-"));
  const installDir = await mkdtemp(join(tmpdir(), "codebase-doctor-mcpb-deps-"));
  try {
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(await manifest(), null, 2)}\n`);
    await cp(join(repositoryRoot, "dist"), join(staging, "server"), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) {
      await cp(join(repositoryRoot, file), join(installDir, file));
    }
    await execFileAsync(
      "npm",
      ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", "--prefix", installDir],
      { cwd: repositoryRoot },
    );
    await cp(join(installDir, "node_modules"), join(staging, "server", "node_modules"), {
      recursive: true,
    });
    await rm(out, { force: true });
    try {
      await execFileAsync("zip", ["-qr", out, "manifest.json", "server"], { cwd: staging });
    } catch (error) {
      throw new Error(
        `build-mcpb: the "zip" binary is required to pack the bundle. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  }
  console.log(`Wrote ${out}`);
}

await main();
