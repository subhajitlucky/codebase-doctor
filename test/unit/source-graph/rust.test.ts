import { describe, expect, it } from "vitest";
import { buildSourceGraph } from "../../../src/source-graph/builder.js";
import { createImportReference, importSpecifier } from "../../../src/source-graph/references.js";
import { parseRustImports } from "../../../src/source-graph/rust-parser.js";
import { resolveRustImport } from "../../../src/source-graph/rust-resolver.js";
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

function rustProject(): DetectedProject {
  return {
    id: "rust",
    root: ".",
    ecosystems: ["rust"],
    languages: ["rust"],
    frameworks: [],
    manifestPaths: ["Cargo.toml"],
    executionSupport: "detected-only",
  };
}

const EMPTY_MANIFESTS: readonly ManifestRecord[] = [];

describe("Rust import parsing", () => {
  it("extracts mod declarations and expands use groups", () => {
    const source = [
      "// use fake::comment;",
      "mod models;",
      "pub mod api;",
      "use crate::models::{User, repo::{self, Store}};",
      "use super::util::format as fmt;",
      "use serde::Serialize;",
      "",
      'const S: &str = "use fake::string;";',
      "",
    ].join("\n");
    const result = parseRustImports("src/lib.rs", source);

    expect(result.status).toBe("completed");
    const modules = result.imports.filter((entry) => entry.kind === "module").map(importSpecifier);
    const uses = result.imports.filter((entry) => entry.kind === "static").map(importSpecifier);
    expect(modules).toEqual(["models", "api"]);
    expect(uses).toEqual([
      "crate::models::User",
      "crate::models::repo::self",
      "crate::models::repo::Store",
      "super::util::format",
      "serde::Serialize",
    ]);
  });

  it("ignores nested block comments, raw strings, and lifetimes", () => {
    const source = [
      "/* outer /* nested use fake::block; */ still */",
      'const R: &str = r#"use fake::raw;"#;',
      "fn borrow<'a>(x: &'a str) -> &'a str { x }",
      "use real::Thing;",
      "",
    ].join("\n");
    const result = parseRustImports("src/lib.rs", source);
    expect(result.imports.map(importSpecifier)).toEqual(["real::Thing"]);
  });

  it("reports unterminated comments as partial coverage", () => {
    const result = parseRustImports("src/lib.rs", "/* unterminated\n");
    expect(result.status).toBe("partial");
    expect(result.limitations[0]).toContain("unterminated");
  });
});

describe("Rust import resolution", () => {
  const paths = [
    "src/lib.rs",
    "src/main.rs",
    "src/models.rs",
    "src/models/repo.rs",
    "src/util/format.rs",
    "src/util/mod.rs",
  ];

  function resolve(importerPath: string, kind: "module" | "static", specifier: string) {
    return resolveRustImport(importerPath, createImportReference(kind, specifier, {}), {
      projects: [rustProject()],
      sourcePaths: new Set(paths),
    });
  }

  it("resolves mod declarations to sibling files and mod.rs directories", () => {
    expect(resolve("src/lib.rs", "module", "models"))
      .toMatchObject({ kind: "internal", targetPath: "src/models.rs", targetExists: true });
    expect(resolve("src/lib.rs", "module", "util"))
      .toMatchObject({ kind: "internal", targetPath: "src/util/mod.rs", targetExists: true });
    expect(resolve("src/models.rs", "module", "repo"))
      .toMatchObject({ kind: "internal", targetPath: "src/models/repo.rs", targetExists: true });
  });

  it("resolves crate, self, and super use paths including item segments", () => {
    expect(resolve("src/lib.rs", "static", "crate::models::User"))
      .toMatchObject({ kind: "internal", targetPath: "src/models.rs", targetExists: true });
    expect(resolve("src/lib.rs", "static", "crate::util::format::helper"))
      .toMatchObject({ kind: "internal", targetPath: "src/util/format.rs", targetExists: true });
    expect(resolve("src/models/repo.rs", "static", "self::Store"))
      .toMatchObject({ kind: "internal", targetPath: "src/models/repo.rs", targetExists: true });
    expect(resolve("src/models/repo.rs", "static", "super::User"))
      .toMatchObject({ kind: "internal", targetPath: "src/models.rs", targetExists: true });
  });

  it("keeps external crates external and reports internal wildcards", () => {
    expect(resolve("src/lib.rs", "static", "serde::Serialize")).toMatchObject({ kind: "external" });
    const wildcard = resolve("src/lib.rs", "static", "crate::models::*");
    expect(wildcard.kind).toBe("external");
    expect(wildcard.limitations.join(" ")).toContain("wildcard Rust import was not expanded");
  });

  it("marks missing modules and use targets as unproven", () => {
    const module = resolve("src/lib.rs", "module", "missing");
    expect(module).toMatchObject({ kind: "internal", targetExists: false });
    expect(module.limitations.join(" ")).toContain("path attributes or cfg were not assumed");

    const use = resolve("src/lib.rs", "static", "crate::missing::Thing");
    expect(use).toMatchObject({ kind: "internal", targetExists: false });
    expect(use.limitations.join(" ")).toContain("build scripts or macros may generate it");
  });
});

describe("Rust source graph integration", () => {
  it("builds edges for Rust modules and use paths", async () => {
    const files: Record<string, string> = {
      "Cargo.toml": "[package]\nname = \"demo\"\n",
      "src/lib.rs": [
        "mod models;",
        "mod missing;",
        "use crate::models::User;",
        "use serde::Serialize;",
        "",
      ].join("\n"),
      "src/models.rs": "pub struct User;\n",
    };
    const graph = await buildSourceGraph(
      inventory(Object.keys(files)),
      EMPTY_MANIFESTS,
      [rustProject()],
      async (path) => files[path]!,
    );

    expect(graph.status).toBe("partial");
    const edges = graph.edges.map((edge) => ({
      importer: edge.importerPath,
      target: edge.targetPath,
      exists: edge.targetExists,
      kind: edge.kind,
    }));
    expect(edges).toEqual([
      { importer: "src/lib.rs", target: "src/missing.rs", exists: false, kind: "module" },
      { importer: "src/lib.rs", target: "src/models.rs", exists: true, kind: "module" },
      { importer: "src/lib.rs", target: "src/models.rs", exists: true, kind: "static" },
    ]);
    expect(graph.externalBoundaryCount).toBe(1);
  });
});
