import { afterEach, describe, expect, it } from "vitest";
import { inventoryFiles } from "../../../src/workspace/file-inventory.js";
import { loadPackageManifests } from "../../../src/workspace/manifest-loader.js";
import { detectProjects } from "../../../src/workspace/project-detector.js";
import type { PackageManager } from "../../../src/workspace/types.js";
import {
  createTempProject,
  removeTempProject,
  writeProjectFile,
} from "../../helpers/temp-project.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempProject));
});

async function detect(files: Record<string, string>) {
  const root = await createTempProject();
  roots.push(root);
  await Promise.all(Object.entries(files).map(([path, contents]) =>
    writeProjectFile(root, path, contents),
  ));
  const inventory = await inventoryFiles(root);
  const manifests = await loadPackageManifests(inventory);
  return detectProjects(inventory, manifests);
}

describe("project detection", () => {
  it("detects Node, TypeScript, frameworks, and the package manager", async () => {
    const result = await detect({
      "package.json": JSON.stringify({
        name: "@example/web",
        dependencies: {
          next: "latest",
          react: "latest",
          "@nestjs/core": "latest",
          "@example/ui": "workspace:*",
        },
        devDependencies: { typescript: "latest", vite: "latest", react: "latest" },
        peerDependencies: { "@example/ui": "workspace:*" },
        optionalDependencies: { optional: "latest" },
      }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    });

    expect(result.projects).toEqual([{
      id: "root",
      root: ".",
      ecosystems: ["node"],
      languages: ["javascript", "typescript"],
      frameworks: ["nestjs", "nextjs", "react", "vite"],
      packageManager: "pnpm",
      packageName: "@example/web",
      dependencyNames: [
        "@example/ui",
        "@nestjs/core",
        "next",
        "optional",
        "react",
        "typescript",
        "vite",
      ],
      manifestPaths: ["package.json"],
      executionSupport: "supported",
    }]);
  });

  it("omits Node metadata for invalid manifests and invalid package names", async () => {
    const result = await detect({
      "apps/broken/package.json": "{not json",
      "apps/blank/package.json": JSON.stringify({
        name: "   ",
        dependencies: { "": "latest", react: "latest" },
      }),
    });

    expect(result.projects).toEqual([
      expect.not.objectContaining({
        root: "apps/blank",
        packageName: expect.anything(),
      }),
      expect.not.objectContaining({
        root: "apps/broken",
        packageName: expect.anything(),
      }),
    ]);
    expect(result.projects[0]).toMatchObject({ dependencyNames: ["react"] });
    expect(result.projects[1]).not.toHaveProperty("dependencyNames");
  });

  it("detects TypeScript from dependency evidence without a tsconfig", async () => {
    const result = await detect({
      "package.json": JSON.stringify({ devDependencies: { typescript: "latest" } }),
    });

    expect(result.projects[0]?.languages).toEqual(["javascript", "typescript"]);
  });

  it.each([
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
  ] as const)("detects %s as %s", async (lockfile, manager) => {
    const result = await detect({
      "package.json": "{}",
      [lockfile]: "lock",
    });

    expect(result.projects[0]?.packageManager).toBe(manager satisfies PackageManager);
  });

  it("detects Python from supported static manifest signals", async () => {
    const result = await detect({
      "services/api/pyproject.toml": "[project]\nname = 'api'\n",
      "services/api/requirements.txt": "fastapi\n",
      "tools/setup.cfg": "[metadata]\nname = tools\n",
    });

    expect(result.projects.map(({ root, ecosystems, languages }) => ({
      root,
      ecosystems,
      languages,
    }))).toEqual([
      { root: "services/api", ecosystems: ["python"], languages: ["python"] },
      { root: "tools", ecosystems: ["python"], languages: ["python"] },
    ]);
  });

  it("expands exact and one-level package workspace entries", async () => {
    const result = await detect({
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["apps/web", "packages/*", "missing/*"],
      }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "packages/api/package.json": JSON.stringify({ name: "api" }),
      "packages/ui/package.json": JSON.stringify({ name: "ui" }),
    });

    expect(result.workspaces).toEqual([
      {
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "apps/web",
        supported: true,
        matchedProjectRoots: ["apps/web"],
      },
      {
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "missing/*",
        supported: true,
        matchedProjectRoots: [],
      },
      {
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "packages/*",
        supported: true,
        matchedProjectRoots: ["packages/api", "packages/ui"],
      },
    ]);
  });

  it("represents a mixed Node and Python monorepo", async () => {
    const result = await detect({
      "package.json": "{}",
      "services/api/pyproject.toml": "[project]\nname = 'api'\n",
    });

    expect(result.projects.map(({ root, ecosystems }) => ({ root, ecosystems }))).toEqual([
      { root: ".", ecosystems: ["node"] },
      { root: "services/api", ecosystems: ["python"] },
    ]);
  });

  it("detects Go, Rust, and Java as metadata-only ecosystems", async () => {
    const result = await detect({
      "go-service/go.mod": "module example.com/service\n",
      "rust-tool/Cargo.toml": "[package]\nname = 'tool'\n",
      "java-api/pom.xml": "<project />\n",
    });

    expect(result.projects.map(({ root, ecosystems, languages, executionSupport }) => ({
      root,
      ecosystems,
      languages,
      executionSupport,
    }))).toEqual([
      {
        root: "go-service",
        ecosystems: ["go"],
        languages: ["go"],
        executionSupport: "detected-only",
      },
      {
        root: "java-api",
        ecosystems: ["java"],
        languages: ["java"],
        executionSupport: "detected-only",
      },
      {
        root: "rust-tool",
        ecosystems: ["rust"],
        languages: ["rust"],
        executionSupport: "detected-only",
      },
    ]);
  });
});
