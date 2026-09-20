import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileInventory, JsonObject, ManifestRecord } from "./types.js";

const MANIFEST_CONCURRENCY = 16;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadManifest(root: string, path: string): Promise<ManifestRecord> {
  try {
    const contents = await readFile(join(root, ...path.split("/")), "utf8");
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
}

export async function loadPackageManifests(
  inventory: FileInventory,
): Promise<ManifestRecord[]> {
  const paths = inventory.files
    .filter(({ kind, path }) => kind === "file" && path.split("/").at(-1) === "package.json")
    .map(({ path }) => path)
    .sort();

  const records: ManifestRecord[] = [];
  for (let start = 0; start < paths.length; start += MANIFEST_CONCURRENCY) {
    const chunk = paths.slice(start, start + MANIFEST_CONCURRENCY);
    records.push(
      ...(await Promise.all(chunk.map((path) => loadManifest(inventory.root, path)))),
    );
  }

  return records;
}
