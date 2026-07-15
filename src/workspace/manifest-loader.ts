import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileInventory, JsonObject, ManifestRecord } from "./types.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadPackageManifests(
  inventory: FileInventory,
): Promise<ManifestRecord[]> {
  const paths = inventory.files
    .filter(({ kind, path }) => kind === "file" && path.split("/").at(-1) === "package.json")
    .map(({ path }) => path)
    .sort();

  return Promise.all(paths.map(async (path): Promise<ManifestRecord> => {
    try {
      const contents = await readFile(join(inventory.root, ...path.split("/")), "utf8");
      const value: unknown = JSON.parse(contents);
      if (!isJsonObject(value)) {
        return {
          kind: "package-json",
          path,
          status: "invalid",
          error: "package.json must contain a JSON object.",
        };
      }
      return { kind: "package-json", path, status: "valid", data: value };
    } catch (error) {
      return {
        kind: "package-json",
        path,
        status: "invalid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}
