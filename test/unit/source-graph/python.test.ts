import { describe, expect, it } from "vitest";
import { buildSourceGraph } from "../../../src/source-graph/builder.js";
import { parsePythonImports } from "../../../src/source-graph/python-parser.js";
import { importSpecifier, createImportReference } from "../../../src/source-graph/references.js";
import { resolveSourceImport } from "../../../src/source-graph/resolver.js";
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
      ? { path: entry, kind: "file" as const, size: 100 }
      : entry),
  };
}

function pythonProject(root = "."): DetectedProject {
  return {
    id: "python",
    root,
    ecosystems: ["python"],
    languages: ["python"],
    frameworks: [],
    manifestPaths: [root === "." ? "pyproject.toml" : `${root}/pyproject.toml`],
    executionSupport: "detected-only",
  };
}

const EMPTY_MANIFESTS: readonly ManifestRecord[] = [];

describe("Python import parsing", () => {
  it("extracts import, from-import, relative, and dynamic forms", () => {
    const source = [
      "import os",
      "import a.b as c, d",
      "from . import models",
      "from .models import User, Post",
      "from ..core import utils",
      "from pkg.sub import thing",
      "from __future__ import annotations",
      "importlib.import_module(\"pkg.dynamic\")",
      "__import__(name)",
      "",
    ].join("\n");
    const result = parsePythonImports("pkg/api.py", source);

    expect(result.status).toBe("completed");
    expect(result.imports.map(importSpecifier)).toEqual([
      "os",
      "a.b",
      "d",
      ".models",
      ".models",
      "..core",
      "pkg.sub",
      "__future__",
      "pkg.dynamic",
    ]);
    expect(result.imports.at(-1)?.kind).toBe("dynamic-literal");
    expect(result.dynamicBoundaryCount).toBe(1);
  });

  it("ignores comments, strings, and triple-quoted blocks", () => {
    const source = [
      "# import fake_comment",
      's = "import fake_string"',
      "t = '''",
      "from .ghost import x",
      "'''",
      "if True:",
      "    import real",
      "x = f'{import_fake}'",
      "",
    ].join("\n");
    const result = parsePythonImports("pkg/api.py", source);

    expect(result.status).toBe("completed");
    expect(result.imports.map(importSpecifier)).toEqual(["real"]);
  });

  it("handles line continuations and parenthesized from-imports", () => {
    const source = [
      "from .models import (",
      "    User,",
      "    Post,",
      ")",
      "import a, \\",
      "    b",
      "",
    ].join("\n");
    const result = parsePythonImports("pkg/api.py", source);

    expect(result.imports.map(importSpecifier)).toEqual([".models", "a", "b"]);
  });

  it("reports an unterminated string as partial coverage", () => {
    const result = parsePythonImports("pkg/api.py", 's = "unterminated\n');
    expect(result.status).toBe("partial");
    expect(result.limitations[0]).toContain("unterminated string");
  });
});

describe("Python import resolution", () => {
  function resolve(importerPath: string, specifier: string, paths: readonly string[]) {
    const files = paths.map((path) => ({ path, kind: "file" as const, size: 100 }));
    return resolveSourceImport(importerPath, createImportReference("static", specifier, {}), {
      files,
      manifests: EMPTY_MANIFESTS,
      projects: [pythonProject()],
      configs: [],
    });
  }

  it("resolves relative module and package targets", () => {
    expect(resolve("pkg/api.py", ".models", ["pkg/api.py", "pkg/models.py"]))
      .toMatchObject({ kind: "internal", targetPath: "pkg/models.py", targetExists: true });
    expect(resolve("pkg/api.py", ".models", ["pkg/api.py", "pkg/models/__init__.py"]))
      .toMatchObject({ kind: "internal", targetPath: "pkg/models/__init__.py", targetExists: true });
    expect(resolve("pkg/sub/api.py", "..core", ["pkg/sub/api.py", "pkg/core.py"]))
      .toMatchObject({ kind: "internal", targetPath: "pkg/core.py", targetExists: true });
  });

  it("proves a missing relative module and withholds proof for a bare dot import", () => {
    const missing = resolve("pkg/api.py", ".missing", ["pkg/api.py"]);
    expect(missing).toMatchObject({
      kind: "internal",
      targetPath: "pkg/missing.py",
      targetExists: false,
      missingTargetProof: "relative-explicit",
    });

    const bare = resolve("pkg/api.py", ".", ["pkg/api.py"]);
    expect(bare.kind).toBe("unsupported");
    expect(bare.limitations[0]).toContain("not provable");
  });

  it("resolves absolute internal imports and leaves third-party names external", () => {
    expect(resolve("app.py", "pkg.models", ["app.py", "pkg/__init__.py", "pkg/models.py"]))
      .toMatchObject({ kind: "internal", targetPath: "pkg/models.py", targetExists: true });
    expect(resolve("app.py", "requests", ["app.py", "pkg/__init__.py"]))
      .toMatchObject({ kind: "external" });
    expect(resolve("app.py", "pkg.missing", ["app.py", "pkg/__init__.py"]))
      .toMatchObject({ kind: "internal", targetExists: false });
  });
});

describe("Python source graph integration", () => {
  it("builds edges for Python imports and proves missing relative targets", async () => {
    const files: Record<string, string> = {
      "app/__init__.py": "",
      "app/api.py": [
        "from .models import User",
        "from .missing import Gone",
        "import app.models",
        "",
      ].join("\n"),
      "app/models.py": "class User: pass\n",
    };
    const graph = await buildSourceGraph(
      inventory(Object.keys(files)),
      EMPTY_MANIFESTS,
      [pythonProject()],
      async (path) => files[path]!,
    );

    expect(graph.status).toBe("partial");
    expect(graph.limitations.join(" ")).toContain("relative Python module was not found");
    expect(graph.nodes.map(({ path }) => path)).toEqual(["app/__init__.py", "app/api.py", "app/models.py"]);
    const edges = graph.edges.map((edge) => ({
      importer: edge.importerPath,
      target: edge.targetPath,
      exists: edge.targetExists,
      proof: edge.targetExists ? undefined : edge.missingTargetProof,
    }));
    expect(edges).toEqual([
      { importer: "app/api.py", target: "app/missing.py", exists: false, proof: "relative-explicit" },
      { importer: "app/api.py", target: "app/models.py", exists: true, proof: undefined },
    ]);
  });
});
