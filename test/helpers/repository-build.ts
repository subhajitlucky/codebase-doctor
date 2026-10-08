import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCK_DIRECTORY = join(tmpdir(), "codebase-doctor-build.lock");
const STALE_LOCK_MS = 10 * 60 * 1000;
const WAIT_STEP_MS = 250;

async function acquireLock(deadline: number): Promise<void> {
  while (true) {
    try {
      await mkdir(LOCK_DIRECTORY);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const info = await stat(LOCK_DIRECTORY);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(LOCK_DIRECTORY, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the repository build lock");
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
  }
}

export async function withRepositoryBuildLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 300_000;
  await acquireLock(deadline);
  try {
    await execFileAsync("npm", ["run", "build"], { cwd: root, timeout: 300_000 });
    return await action();
  } finally {
    await rm(LOCK_DIRECTORY, { recursive: true, force: true });
  }
}
