import { describe, expect, it } from "vitest";
import {
  aliasPattern,
  aliasTargets,
  loadSourceAliasConfigs,
  sourceConfigForPath,
} from "../../../src/source-graph/config.js";
import type { FileInventory, FileRecord } from "../../../src/workspace/types.js";

function inventory(paths: readonly (string | FileRecord)[]): FileInventory {
  return {
    root: "/repo",
    files: paths.map((entry) => typeof entry === "string"
      ? { path: entry, kind: "file", size: 10 }
      : entry),
  };
}

function reader(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = files[path];
    if (value === undefined) throw new Error("seeded read failure must stay private");
    return value;
  };
}

describe("static source alias configuration", () => {
  it("loads JSONC baseUrl plus exact and wildcard aliases", async () => {
    const result = await loadSourceAliasConfigs(
      inventory(["tsconfig.json", "packages/app/tsconfig.json"]),
      reader({
        "tsconfig.json": `{ "compilerOptions": { "baseUrl": "." } }`,
        "packages/app/tsconfig.json": `{
          // static local aliases only
          "compilerOptions": {
            "baseUrl": "src",
            "paths": {
              "@app/*": ["*"],
              "settings": ["config/settings.ts"],
            },
          },
        }`,
      }),
    );
    const config = sourceConfigForPath(result.configs, "packages/app/src/routes.ts");

    expect(result.status).toBe("completed");
    expect(config?.path).toBe("packages/app/tsconfig.json");
    expect(config?.basePath).toBe("packages/app/src");
    expect(config?.aliases.map((alias) => [aliasPattern(alias), aliasTargets(alias)]))
      .toEqual([
        ["@app/*", ["*"]],
        ["settings", ["config/settings.ts"]],
      ]);
  });

  it("follows bounded repository-local relative extends and lets child options win", async () => {
    const result = await loadSourceAliasConfigs(
      inventory(["configs/base.json", "packages/app/tsconfig.json"]),
      reader({
        "configs/base.json": JSON.stringify({
          compilerOptions: {
            baseUrl: "../shared",
            paths: { "@base/*": ["*"] },
          },
        }),
        "packages/app/tsconfig.json": JSON.stringify({
          extends: "../../configs/base.json",
          compilerOptions: {
            baseUrl: "src",
            paths: { "@app/*": ["*"] },
          },
        }),
      }),
    );
    const config = sourceConfigForPath(result.configs, "packages/app/src/index.ts");

    expect(result.status).toBe("completed");
    expect(config?.basePath).toBe("packages/app/src");
    expect(config?.aliases.map(aliasPattern)).toEqual(["@app/*"]);
  });

  it("marks inheritance cycles and the depth ceiling partial", async () => {
    const cycle = await loadSourceAliasConfigs(
      inventory(["a.json", "b.json", "tsconfig.json"]),
      reader({
        "tsconfig.json": `{ "extends": "./a.json" }`,
        "a.json": `{ "extends": "./b.json" }`,
        "b.json": `{ "extends": "./a.json" }`,
      }),
    );
    const depth = await loadSourceAliasConfigs(
      inventory(["a.json", "b.json", "tsconfig.json"]),
      reader({
        "tsconfig.json": `{ "extends": "./a.json" }`,
        "a.json": `{ "extends": "./b.json" }`,
        "b.json": `{}`,
      }),
      { maxExtendsDepth: 1 },
    );

    expect(cycle.status).toBe("partial");
    expect(cycle.limitations).toContain(
      "tsconfig.json: local source configuration inheritance contains a cycle.",
    );
    expect(depth.status).toBe("partial");
    expect(depth.limitations).toContain(
      "tsconfig.json: local source configuration inheritance exceeds the 1-file depth limit.",
    );
  });

  it("does not load package-based inheritance or source config symlinks", async () => {
    const result = await loadSourceAliasConfigs(
      inventory([
        "tsconfig.json",
        { path: "packages/app/jsconfig.json", kind: "symlink", size: 0 },
      ]),
      reader({ "tsconfig.json": `{ "extends": "@company/tsconfig/base" }` }),
    );

    expect(result.status).toBe("partial");
    expect(result.configs).toHaveLength(1);
    expect(result.limitations).toEqual([
      "packages/app/jsconfig.json: source configuration symlink was not read.",
      "tsconfig.json: package-based source configuration inheritance is unsupported.",
    ]);
  });

  it("uses deterministic tsconfig precedence for ambiguous configs", async () => {
    const result = await loadSourceAliasConfigs(
      inventory(["jsconfig.json", "tsconfig.json"]),
      reader({
        "jsconfig.json": `{ "compilerOptions": { "baseUrl": "js" } }`,
        "tsconfig.json": `{ "compilerOptions": { "baseUrl": "ts" } }`,
      }),
    );
    const config = sourceConfigForPath(result.configs, "src/index.ts");

    expect(result.status).toBe("partial");
    expect(config?.path).toBe("tsconfig.json");
    expect(result.limitations).toContain(
      ".: both tsconfig.json and jsconfig.json apply; tsconfig.json was selected.",
    );
  });

  it("uses fixed path-only limitations for invalid or unsafe configuration", async () => {
    const secret = "credential-M7n9B2v8C4x6Z1l3K5j0HgFd";
    const invalid = await loadSourceAliasConfigs(
      inventory(["tsconfig.json"]),
      reader({ "tsconfig.json": `{ "compilerOptions": {` }),
    );
    const unsafe = await loadSourceAliasConfigs(
      inventory(["packages/app/tsconfig.json"]),
      reader({
        "packages/app/tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: `https://user:${secret}@example.invalid`,
            paths: { [`@${secret}/*`]: [`../${secret}/*`] },
          },
        }),
      }),
    );

    expect(invalid.limitations).toEqual([
      "tsconfig.json: source configuration could not be parsed.",
    ]);
    expect(unsafe.status).toBe("partial");
    expect(JSON.stringify(unsafe)).not.toContain(secret);
    expect(JSON.stringify(unsafe)).not.toContain("example.invalid");
  });

  it("rejects invalid inheritance ceilings", async () => {
    await expect(loadSourceAliasConfigs(inventory([]), reader({}), { maxExtendsDepth: 0 }))
      .rejects.toThrow(/positive safe integer/i);
  });
});
