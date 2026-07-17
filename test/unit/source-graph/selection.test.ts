import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_TOTAL_SOURCE_BYTES,
  selectSourceFiles,
} from "../../../src/source-graph/selection.js";
import type { FileInventory, FileRecord } from "../../../src/workspace/types.js";

function inventory(files: readonly FileRecord[]): FileInventory {
  return { root: "/repo", files };
}

describe("source file selection", () => {
  it("selects supported JavaScript and TypeScript files deterministically", () => {
    const result = selectSourceFiles(inventory([
      { path: "src/z.cts", kind: "file", size: 1 },
      { path: "src/a.js", kind: "file", size: 1 },
      { path: "src/b.jsx", kind: "file", size: 1 },
      { path: "src/c.mjs", kind: "file", size: 1 },
      { path: "src/d.cjs", kind: "file", size: 1 },
      { path: "src/e.ts", kind: "file", size: 1 },
      { path: "src/f.d.ts", kind: "file", size: 1 },
      { path: "src/g.tsx", kind: "file", size: 1 },
      { path: "src/h.mts", kind: "file", size: 1 },
      { path: "src/not-source.json", kind: "file", size: 1 },
    ]));

    expect(result.status).toBe("completed");
    expect(result.files.map(({ path }) => path)).toEqual([
      "src/a.js",
      "src/b.jsx",
      "src/c.mjs",
      "src/d.cjs",
      "src/e.ts",
      "src/f.d.ts",
      "src/g.tsx",
      "src/h.mts",
      "src/z.cts",
    ]);
    expect(result.plannedBytes).toBe(9);
    expect(result.limitations).toEqual([]);
  });

  it("reports source symlinks and oversized source files as partial coverage", () => {
    const result = selectSourceFiles(inventory([
      { path: "src/link.ts", kind: "symlink", size: 0 },
      { path: "src/large.ts", kind: "file", size: 11 },
      { path: "src/small.ts", kind: "file", size: 4 },
    ]), { maxSourceBytes: 10, maxTotalSourceBytes: 100 });

    expect(result.status).toBe("partial");
    expect(result.files.map(({ path }) => path)).toEqual(["src/small.ts"]);
    expect(result.limitations).toEqual([
      "src/large.ts: source file exceeds the 10-byte per-file limit.",
      "src/link.ts: source symlink was not parsed.",
    ]);
  });

  it("stops deterministically before exceeding the total byte ceiling", () => {
    const result = selectSourceFiles(inventory([
      { path: "src/c.ts", kind: "file", size: 4 },
      { path: "src/a.ts", kind: "file", size: 4 },
      { path: "src/b.ts", kind: "file", size: 4 },
    ]), { maxSourceBytes: 10, maxTotalSourceBytes: 8 });

    expect(result.status).toBe("partial");
    expect(result.files.map(({ path }) => path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.plannedBytes).toBe(8);
    expect(result.limitations).toEqual([
      "Source selection stopped at the 8-byte total source limit before src/c.ts.",
    ]);
  });

  it("reports no applicable source when the inventory contains no supported file", () => {
    const result = selectSourceFiles(inventory([
      { path: "README.md", kind: "file", size: 10 },
      { path: "src/main.py", kind: "file", size: 10 },
    ]));

    expect(result).toEqual({
      status: "not-applicable",
      files: [],
      plannedBytes: 0,
      limitations: [],
    });
  });

  it("uses stable defaults and rejects invalid resource ceilings", () => {
    expect(DEFAULT_MAX_SOURCE_BYTES).toBe(1_048_576);
    expect(DEFAULT_MAX_TOTAL_SOURCE_BYTES).toBe(52_428_800);
    for (const options of [
      { maxSourceBytes: 0 },
      { maxTotalSourceBytes: -1 },
      { maxSourceBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => selectSourceFiles(inventory([]), options))
        .toThrow(/positive safe integer/i);
    }
  });

  it("never discovers paths outside the supplied bounded inventory", () => {
    const result = selectSourceFiles(inventory([
      { path: "included.ts", kind: "file", size: 1 },
    ]));

    expect(result.files.map(({ path }) => path)).toEqual(["included.ts"]);
  });
});
