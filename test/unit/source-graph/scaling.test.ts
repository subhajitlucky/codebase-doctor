import { describe, expect, it } from "vitest";
import { parseSourceImports } from "../../../src/source-graph/parser.js";
import {
  createSourceResolverIndex,
  resolveSourceImport,
} from "../../../src/source-graph/resolver.js";
import type { FileRecord } from "../../../src/workspace/types.js";

describe("source resolver scaling", () => {
  it("indexes the source inventory once instead of once per import", () => {
    let inventoryReads = 0;
    const files: FileRecord[] = Array.from({ length: 2_000 }, (_, index) =>
      new Proxy<FileRecord>({
        path: `src/file-${index}.ts`,
        kind: "file",
        size: 1,
      }, {
        get(target, property, receiver) {
          if (property === "path" || property === "kind") inventoryReads += 1;
          return Reflect.get(target, property, receiver);
        },
      })
    );
    const context = createSourceResolverIndex({
      files,
      manifests: [],
      projects: [],
      configs: [],
    });
    const readsAfterIndexing = inventoryReads;
    const reference = parseSourceImports("src/importer.ts", 'import "./missing.ts";').imports[0]!;

    for (let index = 0; index < 1_000; index += 1) {
      resolveSourceImport("src/importer.ts", reference, context);
    }

    expect(readsAfterIndexing).toBeLessThanOrEqual(files.length * 2);
    expect(inventoryReads).toBe(readsAfterIndexing);
  });
});
