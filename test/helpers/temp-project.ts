import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runTestGit(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: root,
    encoding: "utf8",
  });
  return stdout;
}

export async function createTempProject(prefix = "codebase-doctor-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeProjectFile(
  root: string,
  relativePath: string,
  contents = "fixture\n",
): Promise<void> {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

export async function initializeGitRepository(root: string): Promise<void> {
  await runTestGit(root, ["init", "--quiet"]);
  await runTestGit(root, ["config", "--local", "user.name", "Codebase Doctor Test"]);
  await runTestGit(root, ["config", "--local", "user.email", "doctor@example.invalid"]);
}

export async function commitInitialContent(
  root: string,
  files: Readonly<Record<string, string>> = { "tracked.txt": "initial\n" },
): Promise<string> {
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeProjectFile(root, relativePath, contents);
  }
  await runTestGit(root, ["add", "--all"]);
  await runTestGit(root, ["commit", "--quiet", "--message", "initial content"]);
  return (await runTestGit(root, ["rev-parse", "HEAD^{commit}"])).trim();
}

export async function captureGitStatus(root: string): Promise<string> {
  return runTestGit(root, ["status", "--porcelain=v1", "-z"]);
}

export async function runGitFixtureCommand(
  root: string,
  args: readonly string[],
): Promise<string> {
  return runTestGit(root, args);
}

export async function removeTempProject(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
