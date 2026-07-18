import { describe, expect, it } from "vitest";
import {
  classifyMissingRelativeTarget,
  loadGeneratedTargetEvidence,
} from "../../../src/source-graph/generated-targets.js";
import type { FileInventory, ManifestRecord } from "../../../src/workspace/types.js";

function manifest(path: string, files: unknown): ManifestRecord {
  return {
    kind: "package-json",
    path,
    status: "valid",
    data: { files },
  };
}

describe("generated target evidence", () => {
  it("recognizes only safe literal nested ignore prefixes", async () => {
    const inventory: FileInventory = {
      root: "/repo",
      files: [
        { path: "bench/module-cost/.gitignore", kind: "file", size: 64 },
      ],
    };
    const loaded = await loadGeneratedTargetEvidence(
      inventory,
      async () => [
        "commonjs/*",
        "esm/**",
        "CPU*",
        "!commonjs/keep.js",
        "../escape/",
        " commonjs-shadow/*",
      ].join("\n"),
    );

    expect(loaded).toEqual({
      evidence: {
        literalIgnoredPrefixes: [
          "bench/module-cost/commonjs",
          "bench/module-cost/esm",
        ],
      },
      limitations: [],
    });
  });

  it("classifies declared publication output from a package staging directory", () => {
    expect(classifyMissingRelativeTarget(
      "packages/react/npm/index.js",
      "packages/react/npm/cjs/react.production.js",
      [manifest("packages/react/package.json", ["index.js", "cjs"])],
      { literalIgnoredPrefixes: [] },
    )).toBe("declared-publication-output");
  });

  it("classifies literal ignored output and exact fixture segments", () => {
    const evidence = {
      literalIgnoredPrefixes: ["bench/module-cost/commonjs"],
    };

    expect(classifyMissingRelativeTarget(
      "bench/module-cost/index.js",
      "bench/module-cost/commonjs/index.js",
      [],
      evidence,
    )).toBe("literal-ignored-output");
    expect(classifyMissingRelativeTarget(
      "tests/fixtures/broken/index.ts",
      "tests/fixtures/broken/missing.ts",
      [],
      evidence,
    )).toBe("fixture-controlled");
    expect(classifyMissingRelativeTarget(
      "tests/fixture-like/index.ts",
      "tests/fixture-like/missing.ts",
      [],
      evidence,
    )).toBe("provable");
  });

  it("rejects ambiguous publication patterns as classifier proof", () => {
    const manifests = [manifest("packages/app/package.json", ["dist/*/index.js", "../outside/"])];

    expect(classifyMissingRelativeTarget(
      "packages/app/src/index.ts",
      "packages/app/dist/client/index.js",
      manifests,
      { literalIgnoredPrefixes: [] },
    )).toBe("provable");
  });
});
