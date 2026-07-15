import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

export async function removeTempProject(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
