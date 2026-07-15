import { afterEach, describe, expect, it } from "vitest";
import { inventoryFiles } from "../../../src/workspace/file-inventory.js";
import { loadPackageManifests } from "../../../src/workspace/manifest-loader.js";
import {
  createTempProject,
  removeTempProject,
  writeProjectFile,
} from "../../helpers/temp-project.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempProject));
});

describe("package manifest loading", () => {
  it("loads valid package objects in deterministic path order", async () => {
    const root = await createTempProject();
    roots.push(root);
    await writeProjectFile(root, "packages/web/package.json", JSON.stringify({ name: "web" }));
    await writeProjectFile(root, "package.json", JSON.stringify({ name: "root", private: true }));

    const manifests = await loadPackageManifests(await inventoryFiles(root));

    expect(manifests).toHaveLength(2);
    expect(manifests.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "package.json", status: "valid" },
      { path: "packages/web/package.json", status: "valid" },
    ]);
    expect(manifests[0]?.status === "valid" && manifests[0].data.name).toBe("root");
  });

  it("preserves syntax and non-object errors as invalid records", async () => {
    const root = await createTempProject();
    roots.push(root);
    await writeProjectFile(root, "broken/package.json", "{ not json");
    await writeProjectFile(root, "array/package.json", "[]");

    const manifests = await loadPackageManifests(await inventoryFiles(root));

    expect(manifests.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "array/package.json", status: "invalid" },
      { path: "broken/package.json", status: "invalid" },
    ]);
    expect(manifests.every((manifest) =>
      manifest.status === "invalid" && manifest.error.length > 0,
    )).toBe(true);
  });
});
