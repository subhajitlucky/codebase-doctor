import { describe, expect, it } from "vitest";
import { buildSourceGraph } from "../../../src/source-graph/builder.js";
import { parseJavaImports } from "../../../src/source-graph/java-parser.js";
import { resolveJavaImport } from "../../../src/source-graph/java-resolver.js";
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

function javaProject(): DetectedProject {
  return {
    id: "java",
    root: ".",
    ecosystems: ["java"],
    languages: ["java"],
    frameworks: [],
    manifestPaths: ["pom.xml"],
    executionSupport: "detected-only",
  };
}

const EMPTY_MANIFESTS: readonly ManifestRecord[] = [];

describe("Java import parsing", () => {
  it("extracts the package declaration and all import forms", () => {
    const source = [
      "package com.example.app;",
      "",
      "// import com.fake.Comment;",
      "import java.util.List;",
      "import java.util.*;",
      "import static com.example.util.Helpers.format;",
      "import com.example.model.User;",
      "",
      "public class App {",
      '  String s = "import com.fake.String;";',
      "}",
      "",
    ].join("\n");
    const result = parseJavaImports("src/main/java/com/example/app/App.java", source);

    expect(result.status).toBe("completed");
    expect(result.packageName).toBe("com.example.app");
    expect(result.imports.map(importSpecifier)).toEqual([
      "java.util.List",
      "java.util.*",
      "com.example.util.Helpers.format",
      "com.example.model.User",
    ]);
    expect(result.imports.map((entry) => entry.kind)).toEqual([
      "static",
      "static",
      "static-import",
      "static",
    ]);
  });

  it("ignores comments, char literals, and text blocks", () => {
    const source = [
      "package app;",
      "/* import fake.block; */",
      "class A {",
      '  char c = \'i\';',
      '  String t = """',
      "    import fake.textblock;",
      '    """;',
      "}",
      "import real.Thing;",
      "",
    ].join("\n");
    const result = parseJavaImports("src/main/java/app/A.java", source);
    expect(result.imports.map(importSpecifier)).toEqual(["real.Thing"]);
  });

  it("reports unterminated input as partial coverage", () => {
    const result = parseJavaImports("A.java", 'class A { String s = "unterminated;\n');
    expect(result.status).toBe("partial");
    expect(result.limitations[0]).toContain("unterminated");
  });
});

describe("Java import resolution", () => {
  function resolve(importerPath: string, specifier: string, paths: readonly string[], kind: "static" | "static-import" = "static") {
    return resolveJavaImport(importerPath, createImportReference(kind, specifier, {}), {
      projects: [javaProject()],
      sourcePaths: new Set(paths),
    });
  }

  const appPath = "src/main/java/com/example/app/App.java";
  const modelPath = "src/main/java/com/example/model/User.java";
  const helperPath = "src/main/java/com/example/util/Helpers.java";

  it("resolves internal class imports under the Maven package root", () => {
    expect(resolve(appPath, "com.example.model.User", [appPath, modelPath]))
      .toMatchObject({ kind: "internal", targetPath: modelPath, targetExists: true });
  });

  it("resolves static member imports to the declaring class file", () => {
    expect(resolve(appPath, "com.example.util.Helpers.format", [appPath, helperPath], "static-import"))
      .toMatchObject({ kind: "internal", targetPath: helperPath, targetExists: true });
  });

  it("keeps standard library imports external", () => {
    expect(resolve(appPath, "java.util.List", [appPath, modelPath])).toMatchObject({ kind: "external" });
  });

  it("reports internal wildcard imports as limitations without edges", () => {
    const internal = resolve(appPath, "com.example.model.*", [appPath, modelPath]);
    expect(internal.kind).toBe("external");
    expect(internal.limitations.join(" ")).toContain("wildcard Java import was not expanded");

    const external = resolve(appPath, "java.util.*", [appPath, modelPath]);
    expect(external.kind).toBe("external");
    expect(external.limitations).toEqual([]);
  });

  it("marks a missing class in an existing package as unproven", () => {
    const missing = resolve(appPath, "com.example.model.Gone", [appPath, modelPath]);
    expect(missing).toMatchObject({
      kind: "internal",
      targetPath: "src/main/java/com/example/model/Gone.java",
      targetExists: false,
    });
    expect(missing.kind === "internal" ? missing.missingTargetProof : "internal").toBeUndefined();
    expect(missing.limitations.join(" ")).toContain("generated or dependency sources");
  });

  it("keeps a missing class in an absent package external", () => {
    expect(resolve(appPath, "com.example.other.Gone", [appPath, modelPath]))
      .toMatchObject({ kind: "external" });
  });
});

describe("Java source graph integration", () => {
  it("builds edges for Java imports", async () => {
    const files: Record<string, string> = {
      "pom.xml": "<project></project>\n",
      "src/main/java/com/example/app/App.java": [
        "package com.example.app;",
        "import com.example.model.User;",
        "import com.example.model.Gone;",
        "import java.util.List;",
        "public class App {}",
        "",
      ].join("\n"),
      "src/main/java/com/example/model/User.java": "package com.example.model;\npublic class User {}\n",
    };
    const graph = await buildSourceGraph(
      inventory(Object.keys(files)),
      EMPTY_MANIFESTS,
      [javaProject()],
      async (path) => files[path]!,
    );

    expect(graph.status).toBe("partial");
    const edges = graph.edges.map((edge) => ({
      importer: edge.importerPath,
      target: edge.targetPath,
      exists: edge.targetExists,
    }));
    expect(edges).toEqual([
      { importer: "src/main/java/com/example/app/App.java", target: "src/main/java/com/example/model/Gone.java", exists: false },
      { importer: "src/main/java/com/example/app/App.java", target: "src/main/java/com/example/model/User.java", exists: true },
    ]);
    expect(graph.externalBoundaryCount).toBe(1);
  });
});
