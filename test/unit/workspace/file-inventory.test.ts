import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryFiles } from "../../../src/workspace/file-inventory.js";
import {
  createTempProject,
  removeTempProject,
  writeProjectFile,
} from "../../helpers/temp-project.js";

const temporaryRoots: string[] = [];

async function project(prefix?: string): Promise<string> {
  const root = await createTempProject(prefix);
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempProject));
});

describe("workspace file inventory", () => {
  it("returns deterministic POSIX-style relative paths", async () => {
    const root = await project();
    await writeProjectFile(root, "z-last.ts");
    await writeProjectFile(root, "src/nested/b.py");
    await writeProjectFile(root, "src/a.ts");

    const inventory = await inventoryFiles(root);

    expect(inventory.root).toBe(root);
    expect(inventory.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "src/a.ts", kind: "file" },
      { path: "src/nested/b.py", kind: "file" },
      { path: "z-last.ts", kind: "file" },
    ]);
    expect(inventory.files.every(({ path }) => !path.includes("\\"))).toBe(true);
  });

  it("skips vendor, generated, virtual environment, and cache directories", async () => {
    const root = await project();
    const ignoredDirectories = [
      ".git",
      "node_modules",
      ".next",
      "dist",
      "build",
      ".venv",
      ".venv-logo-trace",
      "venv",
      "target",
      ".cache",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".turbo",
    ];
    await writeProjectFile(root, "src/keep.ts");
    await Promise.all(ignoredDirectories.map((directory) =>
      writeProjectFile(root, `packages/app/${directory}/ignored.txt`),
    ));

    const inventory = await inventoryFiles(root);

    expect(inventory.files.map(({ path }) => path)).toEqual(["src/keep.ts"]);
  });

  it("records symlinks but never follows directory symlinks", async () => {
    const root = await project();
    const outside = await project("codebase-doctor-outside-");
    await writeProjectFile(root, "real/inside.txt");
    await writeProjectFile(outside, "outside-secret.txt");

    try {
      await symlink(join(root, "real"), join(root, "inside-link"), "dir");
      await symlink(outside, join(root, "outside-link"), "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw error;
    }

    const inventory = await inventoryFiles(root);

    expect(inventory.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "inside-link", kind: "symlink" },
      { path: "outside-link", kind: "symlink" },
      { path: "real/inside.txt", kind: "file" },
    ]);
  });

  it("rejects a missing root and a file root", async () => {
    const root = await project();
    await writeProjectFile(root, "not-a-directory.txt");

    await expect(inventoryFiles(join(root, "missing"))).rejects.toThrow(/does not exist/i);
    await expect(inventoryFiles(join(root, "not-a-directory.txt"))).rejects.toThrow(
      /must be a directory/i,
    );
  });

  it("fails operationally when file or depth limits are exceeded", async () => {
    const root = await project();
    await writeProjectFile(root, "one.txt");
    await writeProjectFile(root, "two.txt");
    await mkdir(join(root, "a", "b", "c"), { recursive: true });

    await expect(inventoryFiles(root, { maxFiles: 1 })).rejects.toThrow(/file limit/i);
    await expect(inventoryFiles(root, { maxDepth: 1 })).rejects.toThrow(/depth limit/i);
  });
});
