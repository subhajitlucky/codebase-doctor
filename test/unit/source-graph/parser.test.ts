import { describe, expect, it } from "vitest";
import {
  importSpecifier,
  parseSourceImports,
} from "../../../src/source-graph/parser.js";

describe("source import parser", () => {
  it("extracts supported static JavaScript and TypeScript dependency syntax", () => {
    const result = parseSourceImports("src/example.ts", `
      import value from "./value.js";
      import type { Model } from "./model.js";
      import { type Shape } from "./shape.js";
      export { helper } from "./helper.js";
      export type { Contract } from "./contract.js";
      export * from "./all.js";
      const common = require("./common.cjs");
      const lazy = import("./lazy.js");
      void [value, common, lazy];
    `);

    expect(result.status).toBe("completed");
    expect(result.imports.map(({ kind }) => kind)).toEqual([
      "static",
      "type-only",
      "type-only",
      "re-export",
      "type-only",
      "re-export",
      "require",
      "dynamic-literal",
    ]);
    expect(result.imports.map(importSpecifier)).toEqual([
      "./value.js",
      "./model.js",
      "./shape.js",
      "./helper.js",
      "./contract.js",
      "./all.js",
      "./common.cjs",
      "./lazy.js",
    ]);
    expect(result.dynamicBoundaryCount).toBe(0);
    expect(result.limitations).toEqual([]);
  });

  it.each([
    ["component.jsx", "export const View = () => <main />;"],
    ["component.tsx", "export const View = (): JSX.Element => <main />;"],
    ["module.mjs", "export { value } from './value.mjs';"],
    ["module.cjs", "module.exports = require('./value.cjs');"],
    ["module.mts", "import type { Value } from './value.mts';"],
    ["module.cts", "const value: unknown = require('./value.cjs');"],
  ])("parses %s without executing it", (path, source) => {
    const result = parseSourceImports(path, source);

    expect(result.status).toBe("completed");
    expect(result.limitations).toEqual([]);
  });

  it("ignores comments, strings, non-call identifiers, and shadow text", () => {
    const result = parseSourceImports("src/comments.ts", `
      // import hidden from "./comment.js";
      const text = "require('./string.js')";
      const object = { import: "./property.js", require: "./property.cjs" };
      function requirement() { return "./not-require.js"; }
      void [text, object, requirement];
    `);

    expect(result.imports).toEqual([]);
    expect(result.dynamicBoundaryCount).toBe(0);
  });

  it("counts non-literal require and import expressions without guessing", () => {
    const result = parseSourceImports("src/dynamic.ts", `
      const first = require(moduleName);
      const second = import(getModule());
      void [first, second];
    `);

    expect(result.imports).toEqual([]);
    expect(result.dynamicBoundaryCount).toBe(2);
  });

  it("does not treat local export declarations as dynamic boundaries", () => {
    const result = parseSourceImports(
      "src/local.ts",
      `export const value = true; export function helper() { return value; }`,
    );

    expect(result.imports).toEqual([]);
    expect(result.dynamicBoundaryCount).toBe(0);
  });

  it("turns malformed syntax into a fixed path-only limitation", () => {
    const secret = "credential-M7n9B2v8C4x6Z1l3K5j0HgFd";
    const result = parseSourceImports(
      "src/broken.ts",
      `import value from "https://user:${secret}@example.invalid/a.js";\nfunction {`,
    );

    expect(result).toEqual({
      status: "partial",
      imports: [],
      dynamicBoundaryCount: 0,
      limitations: ["src/broken.ts: source syntax could not be parsed."],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps literal specifiers out of serialized parser results", () => {
    const secret = "source-M7n9B2v8C4x6Z1l3K5j0HgFd";
    const result = parseSourceImports(
      "src/private.ts",
      `import value from "https://user:${secret}@example.invalid/a.js";`,
    );

    expect(result.status).toBe("completed");
    expect(result.imports).toHaveLength(1);
    expect(importSpecifier(result.imports[0]!)).toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("example.invalid");
  });
});
