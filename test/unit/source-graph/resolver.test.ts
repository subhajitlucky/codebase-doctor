import { describe, expect, it } from "vitest";
import { loadSourceAliasConfigs } from "../../../src/source-graph/config.js";
import { parseSourceImports } from "../../../src/source-graph/parser.js";
import { resolveSourceImport } from "../../../src/source-graph/resolver.js";
import type {
  DetectedProject,
  FileRecord,
  ManifestRecord,
} from "../../../src/workspace/types.js";

function reference(path: string, source: string) {
  const parsed = parseSourceImports(path, source);
  const first = parsed.imports[0];
  if (first === undefined) throw new Error("Expected one parsed import reference.");
  return first;
}

function files(...paths: string[]): FileRecord[] {
  return paths.map((path) => ({ path, kind: "file", size: 1 }));
}

function project(
  id: string,
  root: string,
  packageName?: string,
): DetectedProject {
  return {
    id,
    root,
    ecosystems: ["node"],
    languages: ["typescript"],
    frameworks: [],
    ...(packageName === undefined ? {} : { packageName }),
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported",
  };
}

function manifest(path: string, data: Record<string, unknown>): ManifestRecord {
  return { kind: "package-json", path, status: "valid", data };
}

describe("source import resolver", () => {
  it("resolves exact relative files, extension candidates, and directory indexes", () => {
    const context = {
      files: files("src/exact.ts", "src/extension.ts", "src/folder/index.ts"),
      manifests: [],
      projects: [project("root", ".")],
      configs: [],
    };

    expect(resolveSourceImport("src/importer.ts", reference(
      "src/importer.ts", `import "./exact.ts"`,
    ), context)).toMatchObject({ kind: "internal", targetPath: "src/exact.ts", targetExists: true });
    expect(resolveSourceImport("src/importer.ts", reference(
      "src/importer.ts", `import "./extension"`,
    ), context)).toMatchObject({ kind: "internal", targetPath: "src/extension.ts", targetExists: true });
    expect(resolveSourceImport("src/importer.ts", reference(
      "src/importer.ts", `import "./folder"`,
    ), context)).toMatchObject({ kind: "internal", targetPath: "src/folder/index.ts", targetExists: true });
  });

  it("resolves exact and wildcard aliases from the nearest static config", async () => {
    const configFiles = {
      "packages/app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
          paths: { "@app/*": ["*"], settings: ["config/settings"] },
        },
      }),
    };
    const inventoryFiles = files(
      "packages/app/tsconfig.json",
      "packages/app/src/auth/login.ts",
      "packages/app/src/config/settings.ts",
    );
    const configResult = await loadSourceAliasConfigs(
      { root: "/repo", files: inventoryFiles },
      async (path) => configFiles[path as keyof typeof configFiles],
    );
    const context = {
      files: inventoryFiles,
      manifests: [],
      projects: [project("app", "packages/app")],
      configs: configResult.configs,
    };

    expect(resolveSourceImport("packages/app/src/routes.ts", reference(
      "packages/app/src/routes.ts", `import "@app/auth/login"`,
    ), context)).toMatchObject({
      kind: "internal",
      targetPath: "packages/app/src/auth/login.ts",
      targetExists: true,
    });
    expect(resolveSourceImport("packages/app/src/routes.ts", reference(
      "packages/app/src/routes.ts", `import "settings"`,
    ), context)).toMatchObject({
      kind: "internal",
      targetPath: "packages/app/src/config/settings.ts",
      targetExists: true,
    });
  });

  it("marks aliases with multiple existing targets ambiguous", async () => {
    const configText = JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@value": ["a", "b"] } },
    });
    const inventoryFiles = files("tsconfig.json", "a.ts", "b.ts");
    const configs = await loadSourceAliasConfigs(
      { root: "/repo", files: inventoryFiles },
      async () => configText,
    );
    const result = resolveSourceImport("index.ts", reference(
      "index.ts", `import "@value"`,
    ), {
      files: inventoryFiles,
      manifests: [],
      projects: [project("root", ".")],
      configs: configs.configs,
    });

    expect(result).toEqual({
      kind: "unsupported",
      limitations: ["index.ts: source alias resolves ambiguously."],
    });
  });

  it("resolves unique workspace runtime and type-only entry points", () => {
    const context = {
      files: files(
        "packages/lib/src/runtime.ts",
        "packages/lib/src/index.d.ts",
      ),
      manifests: [manifest("packages/lib/package.json", {
        name: "@workspace/lib",
        module: "./src/runtime.ts",
        types: "./src/index.d.ts",
      })],
      projects: [project("app", "packages/app"), project("lib", "packages/lib", "@workspace/lib")],
      configs: [],
    };

    expect(resolveSourceImport("packages/app/src/index.ts", reference(
      "packages/app/src/index.ts", `import value from "@workspace/lib"`,
    ), context)).toMatchObject({
      kind: "internal",
      targetPath: "packages/lib/src/runtime.ts",
    });
    expect(resolveSourceImport("packages/app/src/index.ts", reference(
      "packages/app/src/index.ts", `import type { Value } from "@workspace/lib"`,
    ), context)).toMatchObject({
      kind: "internal",
      targetPath: "packages/lib/src/index.d.ts",
    });
  });

  it("resolves deterministic workspace subpaths", () => {
    const context = {
      files: files("packages/lib/features/auth.ts"),
      manifests: [manifest("packages/lib/package.json", { name: "@workspace/lib" })],
      projects: [project("lib", "packages/lib", "@workspace/lib")],
      configs: [],
    };
    const result = resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `export * from "@workspace/lib/features/auth"`,
    ), context);

    expect(result).toMatchObject({
      kind: "internal",
      targetPath: "packages/lib/features/auth.ts",
      targetExists: true,
    });
  });

  it("withholds duplicate workspace names and conditional exports as limitations", () => {
    const duplicate = {
      files: files("packages/a/index.ts", "packages/b/index.ts"),
      manifests: [
        manifest("packages/a/package.json", { name: "shared", main: "index.ts" }),
        manifest("packages/b/package.json", { name: "shared", main: "index.ts" }),
      ],
      projects: [project("a", "packages/a", "shared"), project("b", "packages/b", "shared")],
      configs: [],
    };
    const conditional = {
      files: files("packages/lib/src/index.ts"),
      manifests: [manifest("packages/lib/package.json", {
        name: "lib",
        exports: { import: "./src/index.ts", require: "./src/index.cjs" },
      })],
      projects: [project("lib", "packages/lib", "lib")],
      configs: [],
    };

    expect(resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `import "shared"`,
    ), duplicate)).toEqual({
      kind: "unsupported",
      limitations: ["src/index.ts: internal workspace package identity is ambiguous."],
    });
    expect(resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `import "lib"`,
    ), conditional)).toEqual({
      kind: "unsupported",
      limitations: ["src/index.ts: workspace package entry point is unsupported or ambiguous."],
    });
  });

  it("classifies third-party and URL imports as external without exposing values", () => {
    const secret = "credential-M7n9B2v8C4x6Z1l3K5j0HgFd";
    const context = { files: [], manifests: [], projects: [], configs: [] };
    const packageResult = resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `import "react"`,
    ), context);
    const urlResult = resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `import "https://user:${secret}@example.invalid/mod.js"`,
    ), context);

    expect(packageResult).toEqual({ kind: "external", limitations: [] });
    expect(urlResult).toEqual({ kind: "external", limitations: [] });
    expect(JSON.stringify(urlResult)).not.toContain(secret);
    expect(JSON.stringify(urlResult)).not.toContain("example.invalid");
  });

  it("rejects repository escapes and preserves a safe dangling deleted target", () => {
    const context = { files: [], manifests: [], projects: [], configs: [] };
    const escaped = resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `import "../../outside.ts"`,
    ), context);
    const deleted = resolveSourceImport("src/index.ts", reference(
      "src/index.ts", `import "./deleted.ts"`,
    ), context);

    expect(escaped).toEqual({
      kind: "unsupported",
      limitations: ["src/index.ts: source import escapes the repository."],
    });
    expect(deleted).toEqual({
      kind: "internal",
      targetPath: "src/deleted.ts",
      targetExists: false,
      limitations: ["src/index.ts: relative source target was not found in the current inventory."],
    });
  });
});
