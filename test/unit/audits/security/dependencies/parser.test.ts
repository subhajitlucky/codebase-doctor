import { describe, expect, it } from "vitest";
import {
  dependencySpecMatches,
  parseNpmLock,
} from "../../../../../src/audits/security/dependencies/parser.js";

function lock(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: { alpha: "^1.0.0" },
        devDependencies: { tool: "2.0.0" },
      },
      "node_modules/alpha": {
        version: "1.2.0",
        resolved: "https://registry.example.invalid/alpha.tgz",
        integrity: "sha512-QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
      },
    },
    ...overrides,
  });
}

describe("safe npm lock parsing", () => {
  it.each([2, 3] as const)("parses npm lockfile version %s", (version) => {
    const result = parseNpmLock(lock({ lockfileVersion: version }));

    expect(result.status).toBe("supported");
    if (result.status !== "supported") return;
    expect(result.version).toBe(version);
    expect(result.graph.entries.map(({ path }) => path)).toEqual([
      "",
      "node_modules/alpha",
    ]);
    expect(result.graph.entries[0]).toMatchObject({
      path: "",
      sections: {
        dependencies: ["alpha"],
        devDependencies: ["tool"],
        optionalDependencies: [],
        peerDependencies: [],
      },
    });
    expect(result.graph.entries[1]).toMatchObject({
      packageName: "alpha",
      sourceClass: "secure-https",
      integrity: "valid",
      link: false,
    });
    expect(dependencySpecMatches(result.graph, "", "dependencies", "alpha", "^1.0.0"))
      .toBe(true);
    expect(dependencySpecMatches(result.graph, "", "dependencies", "alpha", "^2.0.0"))
      .toBe(false);
  });

  it("parses workspace links, scoped and nested package entries", () => {
    const result = parseNpmLock(lock({
      packages: {
        "": { dependencies: { "@scope/api": "1.0.0" } },
        "packages/api": { name: "@scope/api", optionalDependencies: { beta: "3.0.0" } },
        "node_modules/@scope/api": { resolved: "packages/api", link: true },
        "node_modules/alpha/node_modules/beta": {
          resolved: "https://registry.example.invalid/beta.tgz",
        },
      },
    }));

    expect(result.status).toBe("supported");
    if (result.status !== "supported") return;
    expect(result.graph.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "node_modules/@scope/api",
        packageName: "@scope/api",
        link: true,
        resolvedWorkspacePath: "packages/api",
        integrity: "not-required",
      }),
      expect.objectContaining({
        path: "node_modules/alpha/node_modules/beta",
        packageName: "beta",
        integrity: "missing",
      }),
    ]));
  });

  it("sorts paths and dependency names deterministically", () => {
    const result = parseNpmLock(lock({
      packages: {
        "node_modules/zeta": {},
        "": { dependencies: { zeta: "1", alpha: "1" } },
        "node_modules/alpha": {},
      },
    }));

    expect(result.status).toBe("supported");
    if (result.status !== "supported") return;
    expect(result.graph.entries.map(({ path }) => path)).toEqual([
      "",
      "node_modules/alpha",
      "node_modules/zeta",
    ]);
    expect(result.graph.entries[0]?.sections.dependencies).toEqual(["alpha", "zeta"]);
  });

  it.each([1, 4, 99])("reports lockfile version %s as unsupported safely", (version) => {
    expect(parseNpmLock(lock({ lockfileVersion: version }))).toEqual({
      status: "unsupported",
      limitations: ["Selected npm lockfile version is unsupported."],
    });
  });

  it.each([
    ["not-json", "Selected npm lockfile is not valid JSON."],
    [JSON.stringify([]), "Selected npm lockfile must contain a JSON object."],
    [JSON.stringify({ lockfileVersion: 3 }), "Selected npm lockfile has no packages object."],
    [JSON.stringify({ lockfileVersion: 3, packages: { "": [] } }), "Selected npm lockfile contains an invalid package entry."],
  ])("returns a fixed safe limitation for invalid input", (content, limitation) => {
    expect(parseNpmLock(content)).toEqual({ status: "invalid", limitations: [limitation] });
  });

  it("skips unsafe paths and fields with fixed limitations", () => {
    const result = parseNpmLock(lock({
      packages: {
        "../escape": {},
        "": { dependencies: { "unsafe name": 4, safe: "1.0.0" } },
      },
    }));

    expect(result.status).toBe("supported");
    if (result.status !== "supported") return;
    expect(result.graph.entries.map(({ path }) => path)).toEqual([""]);
    expect(result.graph.entries[0]?.sections.dependencies).toEqual(["safe"]);
    expect(result.limitations).toEqual([
      "Selected npm lockfile contains an invalid dependency entry.",
      "Selected npm lockfile contains an unsafe package path.",
    ]);
  });

  it("never serializes raw dependency specifications or resolved credentials", () => {
    const seed = ["lock", "-url-", "credential-7Qp9"].join("");
    const content = lock({
      packages: {
        "": { dependencies: { alpha: `https://user:${seed}@example.invalid/a.tgz` } },
        "node_modules/alpha": {
          resolved: `https://user:${seed}@example.invalid/a.tgz?token=${seed}`,
        },
      },
    });
    const result = parseNpmLock(content);

    expect(result.status).toBe("supported");
    expect(JSON.stringify(result)).not.toContain(seed);
    if (result.status !== "supported") return;
    expect(dependencySpecMatches(
      result.graph,
      "",
      "dependencies",
      "alpha",
      `https://user:${seed}@example.invalid/a.tgz`,
    )).toBe(true);
  });
});
