import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SOURCE_EDGES,
  buildSourceGraph,
} from "../../../src/source-graph/builder.js";
import type {
  DetectedProject,
  FileInventory,
  FileRecord,
  ManifestRecord,
} from "../../../src/workspace/types.js";

function inventory(paths: readonly (string | FileRecord)[]): FileInventory {
  return {
    root: "/repo",
    files: paths.map((entry) => typeof entry === "string"
      ? { path: entry, kind: "file", size: 100 }
      : entry),
  };
}

function project(id: string, root: string): DetectedProject {
  return {
    id,
    root,
    ecosystems: ["node"],
    languages: ["typescript"],
    frameworks: [],
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported",
  };
}

function reader(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = files[path];
    if (value === undefined) throw new Error("private read failure detail");
    return value;
  };
}

async function build(
  fileInventory: FileInventory,
  contents: Readonly<Record<string, string>>,
  projects: readonly DetectedProject[] = [project("root", ".")],
  manifests: readonly ManifestRecord[] = [],
  options: Parameters<typeof buildSourceGraph>[4] = {},
) {
  return buildSourceGraph(fileInventory, manifests, projects, reader(contents), options);
}

describe("bounded source graph builder", () => {
  it("builds deterministic safe nodes and reduced internal edges", async () => {
    const first = await build(
      inventory(["src/routes.ts", "src/auth/session.ts"]),
      {
        "src/routes.ts": `
          import "./auth/session";
          import "./auth/session";
          import "react";
          import(getName());
        `,
        "src/auth/session.ts": `export const session = true;`,
      },
    );
    const second = await build(
      inventory(["src/auth/session.ts", "src/routes.ts"]),
      {
        "src/auth/session.ts": `export const session = true;`,
        "src/routes.ts": `
          import "./auth/session";
          import "./auth/session";
          import "react";
          import(getName());
        `,
      },
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "completed",
      nodes: [
        { path: "src/auth/session.ts", projectId: "root" },
        { path: "src/routes.ts", projectId: "root" },
      ],
      edges: [{
        importerPath: "src/routes.ts",
        targetPath: "src/auth/session.ts",
        kind: "static",
        targetExists: true,
      }],
      filesExamined: 2,
      externalBoundaryCount: 1,
      dynamicBoundaryCount: 1,
      limitations: [],
    });
    expect(first.bytesExamined).toBeGreaterThan(0);
  });

  it("assigns each source node to its most specific project", async () => {
    const result = await build(
      inventory(["src/root.ts", "packages/app/src/app.ts"]),
      {
        "src/root.ts": "export {};",
        "packages/app/src/app.ts": "export {};",
      },
      [project("root", "."), project("app", "packages/app")],
    );

    expect(result.nodes).toEqual([
      { path: "packages/app/src/app.ts", projectId: "app" },
      { path: "src/root.ts", projectId: "root" },
    ]);
  });

  it("retains safe proof and the first deterministic location for missing edges", async () => {
    const secret = "credential-H8m4Q2v7N5k9";
    const result = await build(
      inventory(["src/importer.ts", "src/present.ts"]),
      {
        "src/importer.ts": [
          `import "./missing.ts";`,
          `import "./missing.ts";`,
          `import "./extensionless";`,
          `import "./present.ts";`,
          `// import "https://user:${secret}@example.invalid/comment.ts";`,
          `const text = "import('https://user:${secret}@example.invalid/string.ts')";`,
        ].join("\n"),
        "src/present.ts": "export {};",
      },
    );

    expect(result.edges).toEqual([
      {
        importerPath: "src/importer.ts",
        targetPath: "src/extensionless.ts",
        kind: "static",
        targetExists: false,
        line: 3,
        column: 1,
      },
      {
        importerPath: "src/importer.ts",
        targetPath: "src/missing.ts",
        kind: "static",
        targetExists: false,
        missingTargetProof: "relative-explicit",
        line: 1,
        column: 1,
      },
      {
        importerPath: "src/importer.ts",
        targetPath: "src/present.ts",
        kind: "static",
        targetExists: true,
        line: 4,
        column: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("example.invalid");
  });

  it("loads nested ignore evidence once and keeps generated targets coverage-only", async () => {
    const reads = new Map<string, number>();
    const result = await buildSourceGraph(
      inventory([
        "bench/module-cost/.gitignore",
        "bench/module-cost/index.js",
      ]),
      [],
      [project("root", ".")],
      async (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        if (path === "bench/module-cost/.gitignore") return "commonjs/*\n";
        if (path === "bench/module-cost/index.js") return `require("./commonjs/index.js")`;
        throw new Error("unexpected path");
      },
    );

    expect(reads.get("bench/module-cost/.gitignore")).toBe(1);
    expect(result.edges).toEqual([{
      importerPath: "bench/module-cost/index.js",
      targetPath: "bench/module-cost/commonjs/index.js",
      kind: "require",
      targetExists: false,
      line: 1,
      column: 1,
    }]);
    expect(result.limitations).toContain(
      "bench/module-cost/index.js: relative source target is covered by a literal ignore rule and may be generated.",
    );
  });

  it("combines selection, configuration, parse, read, and resolution limitations", async () => {
    const secret = "credential-M7n9B2v8C4x6Z1l3K5j0HgFd";
    const result = await build(
      inventory([
        { path: "src/link.ts", kind: "symlink", size: 0 },
        "src/broken.ts",
        "src/missing.ts",
        "tsconfig.json",
      ]),
      {
        "src/broken.ts": `import "https://user:${secret}@example.invalid/a.js";\nfunction {`,
        "tsconfig.json": `{ "compilerOptions": {`,
      },
    );

    expect(result.status).toBe("partial");
    expect(result.limitations).toEqual(expect.arrayContaining([
      "src/broken.ts: source syntax could not be parsed.",
      "src/link.ts: source symlink was not parsed.",
      "src/missing.ts: source file could not be read.",
      "tsconfig.json: source configuration could not be parsed.",
    ]));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("private read failure detail");
  });

  it("enforces actual per-file and total read ceilings even when inventory sizes are stale", async () => {
    const perFile = await build(
      inventory([{ path: "src/large.ts", kind: "file", size: 1 }]),
      { "src/large.ts": "x".repeat(11) },
      [project("root", ".")],
      [],
      { maxSourceBytes: 10, maxTotalSourceBytes: 100 },
    );
    const total = await build(
      inventory([
        { path: "src/a.ts", kind: "file", size: 1 },
        { path: "src/b.ts", kind: "file", size: 1 },
      ]),
      { "src/a.ts": "a".repeat(6), "src/b.ts": "b".repeat(6) },
      [project("root", ".")],
      [],
      { maxSourceBytes: 10, maxTotalSourceBytes: 10 },
    );

    expect(perFile).toMatchObject({ status: "partial", filesExamined: 0, bytesExamined: 0 });
    expect(perFile.limitations).toContain(
      "src/large.ts: source file exceeds the 10-byte per-file limit after reading.",
    );
    expect(total).toMatchObject({ status: "partial", filesExamined: 1, bytesExamined: 6 });
    expect(total.limitations).toContain(
      "Source graph stopped at the 10-byte total source limit before src/b.ts.",
    );
  });

  it("stops internal edge construction at a validated ceiling", async () => {
    const result = await build(
      inventory(["src/a.ts", "src/b.ts", "src/c.ts"]),
      {
        "src/a.ts": `import "./b"; import "./c";`,
        "src/b.ts": "export {};",
        "src/c.ts": "export {};",
      },
      [project("root", ".")],
      [],
      { maxEdges: 1 },
    );

    expect(DEFAULT_MAX_SOURCE_EDGES).toBe(100_000);
    expect(result.status).toBe("partial");
    expect(result.edges).toHaveLength(1);
    expect(result.limitations).toContain(
      "Source graph stopped at the 1-edge internal graph limit.",
    );
    await expect(build(inventory([]), {}, [], [], { maxEdges: 0 }))
      .rejects.toThrow(/positive safe integer/i);
  });

  it("reports no applicable graph when no supported source is inventoried", async () => {
    const result = await build(inventory(["README.md"]), {});

    expect(result).toEqual({
      status: "not-applicable",
      nodes: [],
      edges: [],
      filesExamined: 0,
      bytesExamined: 0,
      externalBoundaryCount: 0,
      dynamicBoundaryCount: 0,
      limitations: [],
    });
  });
});
