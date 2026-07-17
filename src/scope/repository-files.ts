import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_BUFFER_BYTES = 16 * 1024 * 1024;
const UNAVAILABLE_LIMITATION =
  "Git shareable-file selection was unavailable; conservative local-environment fallback rules were used.";

export interface RepositoryFileSelection {
  readonly availability: "available" | "unavailable";
  readonly paths: readonly string[];
  readonly limitations: readonly string[];
}

export interface RepositoryFileRunner {
  run(root: string, args: readonly string[]): Promise<string>;
}

const defaultRunner: RepositoryFileRunner = {
  async run(root, args) {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
    });
    return stdout;
  },
};

function normalizeRepositoryPath(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("Git path must not be empty or contain NUL bytes.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    throw new Error("Git path must be repository-relative.");
  }
  if (value.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("Git path must not contain parent-directory segments.");
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Git path escapes the repository.");
  }
  return normalized;
}

export function parseRepositoryFiles(output: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) {
    throw new Error("Git output must be NUL-terminated.");
  }
  const tokens = output.split("\0");
  tokens.pop();
  return [...new Set(tokens.map(normalizeRepositoryPath))].sort();
}

function unavailable(): RepositoryFileSelection {
  return {
    availability: "unavailable",
    paths: [],
    limitations: [UNAVAILABLE_LIMITATION],
  };
}

export async function discoverRepositoryFiles(
  requestedRoot: string,
  runner: RepositoryFileRunner = defaultRunner,
): Promise<RepositoryFileSelection> {
  try {
    const root = await realpath(requestedRoot);
    const reportedRoot = (await runner.run(root, ["rev-parse", "--show-toplevel"]))
      .replace(/\n$/u, "");
    if (await realpath(reportedRoot) !== root) return unavailable();

    const output = await runner.run(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    return {
      availability: "available",
      paths: parseRepositoryFiles(output),
      limitations: [],
    };
  } catch {
    return unavailable();
  }
}
