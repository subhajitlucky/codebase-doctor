import { describe, expect, it } from "vitest";
import { buildSourceGraph } from "../../../src/source-graph/builder.js";
import { parseGoMod } from "../../../src/source-graph/go-mod.js";
import { parseGoImports } from "../../../src/source-graph/go-parser.js";
import { resolveGoImport } from "../../../src/source-graph/go-resolver.js";
import { createImportReference, importSpecifier } from "../../../src/source-graph/references.js";
import type {
  DetectedProject,
  FileInventory,
  ManifestRecord,
} from "../../../src/workspace/types.js";

function inventory(paths: readonly string[]): FileInventory {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 100 })),
  };
}

function goProject(root = "."): DetectedProject {
  return {
    id: "go",
    root,
    ecosystems: ["go"],
    languages: ["go"],
    frameworks: [],
    manifestPaths: [root === "." ? "go.mod" : `${root}/go.mod`],
    executionSupport: "detected-only",
  };
}

const EMPTY_MANIFESTS: readonly ManifestRecord[] = [];

describe("Go import parsing", () => {
  it("extracts single and block imports with aliases", () => {
    const source = [
      "package main",
      "",
      '// import "fake/comment"',
      "",
      'import "fmt"',
      "import (",
      '\t"strings"',
      '\talias "github.com/me/proj/pkg/a"',
      '\t_ "github.com/me/proj/pkg/b"',
      '\t. "github.com/me/proj/pkg/c"',
      ")",
      "",
      'var s = "import \\"fake/string\\""',
      "",
    ].join("\n");
    const result = parseGoImports("cmd/app/main.go", source);

    expect(result.status).toBe("completed");
    expect(result.imports.map(importSpecifier)).toEqual([
      "fmt",
      "strings",
      "github.com/me/proj/pkg/a",
      "github.com/me/proj/pkg/b",
      "github.com/me/proj/pkg/c",
    ]);
    expect(result.imports.every((entry) => entry.kind === "static")).toBe(true);
  });

  it("ignores raw strings, rune literals, and block comments", () => {
    const source = [
      "package main",
      "/*",
      'import "fake/block"',
      "*/",
      "var raw = `",
      'import "fake/raw"',
      "`",
      "var r = 'i'",
      'import "real"',
      "",
    ].join("\n");
    const result = parseGoImports("main.go", source);
    expect(result.imports.map(importSpecifier)).toEqual(["real"]);
  });

  it("reports unterminated strings as partial coverage", () => {
    const result = parseGoImports("main.go", 'import "unterminated\n');
    expect(result.status).toBe("partial");
    expect(result.limitations[0]).toContain("unterminated");
  });
});

describe("Go module metadata", () => {
  it("parses the module path and replace directives", () => {
    expect(parseGoMod("module github.com/me/proj\n\ngo 1.22\n", "."))
      .toMatchObject({ modulePath: "github.com/me/proj", hasReplace: false });
    expect(parseGoMod('module "github.com/me/proj"\nreplace github.com/x => ../x\n', "."))
      .toMatchObject({ modulePath: "github.com/me/proj", hasReplace: true });
    expect(parseGoMod("go 1.22\n", ".")).toBeUndefined();
  });
});

describe("Go import resolution", () => {
  const modules = new Map([["." as string, {
    root: ".",
    modulePath: "github.com/me/proj",
    hasReplace: false,
  }]]);

  function resolve(importerPath: string, specifier: string, paths: readonly string[], hasReplace = false) {
    const sourcePaths = new Set(paths);
    return resolveGoImport(importerPath, specifier, {
      projects: [goProject()],
      sourcePaths,
      goModules: new Map([["." as string, {
        root: ".",
        modulePath: "github.com/me/proj",
        hasReplace,
      }]]),
    });
  }

  it("resolves internal packages to a deterministic non-test file", () => {
    expect(resolve("cmd/app/main.go", "github.com/me/proj/pkg/a", [
      "cmd/app/main.go",
      "pkg/a/a_test.go",
      "pkg/a/a.go",
    ])).toMatchObject({ kind: "internal", targetPath: "pkg/a/a.go", targetExists: true });
  });

  it("proves a missing internal package unless a replace directive exists", () => {
    const provable = resolve("cmd/app/main.go", "github.com/me/proj/pkg/missing", ["cmd/app/main.go"]);
    expect(provable).toMatchObject({
      kind: "internal",
      targetPath: "pkg/missing",
      targetExists: false,
      missingTargetProof: "module-internal",
    });

    const replaced = resolve("cmd/app/main.go", "github.com/me/proj/pkg/missing", ["cmd/app/main.go"], true);
    expect(replaced).toMatchObject({ kind: "internal", targetExists: false });
    expect(replaced.kind === "internal" ? replaced.missingTargetProof : "internal").toBeUndefined();
    expect(replaced.limitations.join(" ")).toContain("replace directive");
  });

  it("keeps standard library and third-party imports external", () => {
    expect(resolve("main.go", "fmt", ["main.go"])).toMatchObject({ kind: "external" });
    expect(resolve("main.go", "github.com/other/lib", ["main.go"])).toMatchObject({ kind: "external" });
  });

  it("withholds resolution when no module path is loaded", () => {
    const resolution = resolveGoImport("main.go", "github.com/me/proj/pkg/a", {
      projects: [goProject()],
      sourcePaths: new Set(["pkg/a/a.go"]),
    });
    expect(resolution.kind).toBe("unsupported");
    expect(resolution.limitations[0]).toContain("module path is unavailable");
  });

  it("skips go.work-only layouts with a limitation", async () => {
    const { loadGoModuleInfo } = await import("../../../src/source-graph/go-mod.js");
    const result = await loadGoModuleInfo(
      inventory(["go.work", "pkg/a/a.go"]),
      [goProject()],
      async () => "go 1.22\nuse ./pkg/a\n",
    );
    expect(result.modules.size).toBe(0);
    expect(result.limitations[0]).toContain("go.work");
  });
});

describe("Go source graph integration", () => {
  it("builds edges and proves a missing internal package", async () => {
    const files: Record<string, string> = {
      "go.mod": "module github.com/me/proj\n\ngo 1.22\n",
      "cmd/app/main.go": [
        "package main",
        "",
        "import (",
        '\t"github.com/me/proj/pkg/a"',
        '\t"github.com/me/proj/pkg/missing"',
        '\t"fmt"',
        ")",
        "",
        "func main() { fmt.Println(a.Value) }",
        "",
      ].join("\n"),
      "pkg/a/a.go": "package a\n\nvar Value = 1\n",
    };
    const graph = await buildSourceGraph(
      inventory(Object.keys(files)),
      EMPTY_MANIFESTS,
      [goProject()],
      async (path) => files[path]!,
    );

    expect(graph.status).toBe("partial");
    expect(graph.limitations.join(" ")).toContain("internal Go package is not present");
    const edges = graph.edges.map((edge) => ({
      importer: edge.importerPath,
      target: edge.targetPath,
      exists: edge.targetExists,
      proof: edge.targetExists ? undefined : edge.missingTargetProof,
    }));
    expect(edges).toEqual([
      { importer: "cmd/app/main.go", target: "pkg/a/a.go", exists: true, proof: undefined },
      { importer: "cmd/app/main.go", target: "pkg/missing", exists: false, proof: "module-internal" },
    ]);
    expect(graph.externalBoundaryCount).toBe(1);
  });
});
