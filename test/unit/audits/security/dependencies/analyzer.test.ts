import { describe, expect, it } from "vitest";
import { analyzeDependencyTarget } from "../../../../../src/audits/security/dependencies/analyzer.js";
import { parseNpmLock } from "../../../../../src/audits/security/dependencies/parser.js";
import type { DependencyAuditTarget } from "../../../../../src/audits/security/dependencies/selection.js";
import type { ManifestRecord } from "../../../../../src/workspace/types.js";

function manifest(
  path: string,
  data: Record<string, unknown>,
): Extract<ManifestRecord, { status: "valid" }> {
  return { kind: "package-json", path, status: "valid", data };
}

function target(overrides: Partial<DependencyAuditTarget> = {}): DependencyAuditTarget {
  return {
    lockRoot: ".",
    authority: "package-lock",
    lockfile: { path: "package-lock.json", kind: "file", size: 100 },
    coveredProjects: [{ projectId: "root", root: ".", manifestPath: "package.json" }],
    competingLockfilePaths: [],
    scope: "full",
    ...overrides,
  };
}

function unlockedTarget(): DependencyAuditTarget {
  const { lockfile: _lockfile, ...base } = target();
  return { ...base, authority: "none" };
}

function parsedLock(
  packages: Record<string, unknown>,
  lockfileVersion = 3,
) {
  return parseNpmLock(JSON.stringify({ lockfileVersion, packages }));
}

describe("offline dependency target analysis", () => {
  it("reports an external install graph without a governing lockfile", () => {
    const result = analyzeDependencyTarget({
      target: unlockedTarget(),
      manifests: [manifest("package.json", { dependencies: { alpha: "^1.0.0" } })],
      internalPackages: [],
    });

    expect(result).toEqual({
      matches: [expect.objectContaining({
        family: "missing-lockfile",
        path: "package.json",
        severity: "medium",
        confidence: "high",
      })],
      limitations: [],
    });
  });

  it.each([
    { peerDependencies: { alpha: "^1.0.0" } },
    { dependencies: { shared: "file:../shared" } },
    { dependencies: { shared: "link:../shared" } },
    { dependencies: { shared: "workspace:^" } },
  ])("does not require a lock for peer-only or local-only metadata", (data) => {
    const result = analyzeDependencyTarget({
      target: unlockedTarget(),
      manifests: [manifest("package.json", data)],
      internalPackages: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("does not require a lock when the only dependency is an internal workspace package", () => {
    const result = analyzeDependencyTarget({
      target: unlockedTarget(),
      manifests: [manifest("package.json", { dependencies: { shared: "^1.0.0" } })],
      internalPackages: [{ name: "shared", root: "packages/shared" }],
    });

    expect(result.matches).toEqual([]);
  });

  it("reports missing, extra, and different direct lock metadata by section", () => {
    const lock = parsedLock({
      "": {
        dependencies: { alpha: "^2.0.0", extra: "1.0.0" },
        devDependencies: {},
        optionalDependencies: { optional: "3.0.0" },
        peerDependencies: { peer: "4.0.0" },
      },
    });
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", {
        dependencies: { alpha: "^1.0.0", missing: "1.0.0" },
        devDependencies: { tool: "2.0.0" },
        optionalDependencies: { optional: "3.0.0" },
        peerDependencies: { peer: "4.0.0" },
      })],
      lock,
      internalPackages: [],
    });

    expect(result.matches.filter(({ family }) => family === "manifest-lock-drift"))
      .toEqual([
        expect.objectContaining({ packageName: "alpha", section: "dependencies" }),
        expect.objectContaining({ packageName: "extra", section: "dependencies" }),
        expect.objectContaining({ packageName: "missing", section: "dependencies" }),
        expect.objectContaining({ packageName: "tool", section: "devDependencies" }),
      ]);
    expect(result.matches).not.toContainEqual(expect.objectContaining({ packageName: "optional" }));
    expect(result.matches).not.toContainEqual(expect.objectContaining({ packageName: "peer" }));
  });

  it("maps workspace manifests to their repository-relative packages entry", () => {
    const lock = parsedLock({
      "": { dependencies: { rootdep: "^1.0.0" } },
      "packages/api": { dependencies: { apiDep: "^2.0.0" } },
    });
    const result = analyzeDependencyTarget({
      target: target({
        coveredProjects: [
          { projectId: "root", root: ".", manifestPath: "package.json" },
          { projectId: "api", root: "packages/api", manifestPath: "packages/api/package.json" },
        ],
      }),
      manifests: [
        manifest("package.json", { dependencies: { rootdep: "^1.0.0" } }),
        manifest("packages/api/package.json", { dependencies: { apiDep: "^2.0.0" } }),
      ],
      lock,
      internalPackages: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("allows normal exact and ranged versions when lock metadata agrees", () => {
    const lock = parsedLock({
      "": { dependencies: { exact: "5.0.0", ranged: "^5.0.0" } },
    });
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", {
        dependencies: { exact: "5.0.0", ranged: "^5.0.0" },
      })],
      lock,
      internalPackages: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("reports competing npm lockfiles once", () => {
    const result = analyzeDependencyTarget({
      target: target({
        authority: "shrinkwrap",
        lockfile: { path: "npm-shrinkwrap.json", kind: "file", size: 100 },
        competingLockfilePaths: ["package-lock.json"],
      }),
      manifests: [manifest("package.json", {})],
      lock: parsedLock({ "": {} }),
      internalPackages: [],
    });

    expect(result.matches).toContainEqual(expect.objectContaining({
      family: "competing-npm-lockfiles",
      path: "package-lock.json",
      severity: "low",
      confidence: "high",
    }));
  });

  it("turns invalid or unsupported lock structure into safe limitations", () => {
    const invalid = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: "1.0.0" } })],
      lock: parseNpmLock("invalid-json-with-sensitive-detail"),
      internalPackages: [],
    });
    const unsupported = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: "1.0.0" } })],
      lock: parsedLock({}, 1),
      internalPackages: [],
    });

    expect(invalid.matches).toEqual([]);
    expect(invalid.limitations).toEqual([
      "package-lock.json: Selected npm lockfile is not valid JSON.",
    ]);
    expect(unsupported.matches).toEqual([]);
    expect(unsupported.limitations).toEqual([
      "package-lock.json: Selected npm lockfile version is unsupported.",
    ]);
    expect(JSON.stringify(invalid)).not.toContain("sensitive-detail");
  });

  it("never returns a raw mismatched dependency specification", () => {
    const seed = ["raw", "-dependency-", "credential-4Nk"].join("");
    const lock = parsedLock({ "": { dependencies: { alpha: "1.0.0" } } });
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", {
        dependencies: { alpha: `https://user:${seed}@example.invalid/a.tgz` },
      })],
      lock,
      internalPackages: [],
    });

    expect(result.matches).toContainEqual(expect.objectContaining({
      family: "manifest-lock-drift",
      packageName: "alpha",
    }));
    expect(JSON.stringify(result)).not.toContain(seed);
  });

  it.each([
    ["http://packages.example.invalid/alpha.tgz", "insecure-http"],
    ["git+http://git.example.invalid/team/alpha.git", "insecure-http"],
    ["git://git.example.invalid/team/alpha.git", "insecure-git"],
  ] as const)("reports a direct insecure dependency source %s", (spec, sourceClass) => {
    const lock = parsedLock({ "": { dependencies: { alpha: spec } } });
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: spec } })],
      lock,
      internalPackages: [],
    });

    expect(result.matches).toContainEqual(expect.objectContaining({
      family: "insecure-source",
      path: "package.json",
      packageName: "alpha",
      section: "dependencies",
      sourceClass,
      severity: "high",
      confidence: "high",
    }));
  });

  it("reports an insecure resolved source from the lock graph", () => {
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", {})],
      lock: parsedLock({
        "": {},
        "node_modules/transitive": {
          resolved: "http://packages.example.invalid/transitive.tgz",
        },
      }),
      internalPackages: [],
    });

    expect(result.matches).toContainEqual(expect.objectContaining({
      family: "insecure-source",
      path: "package-lock.json",
      packageName: "transitive",
      sourceClass: "insecure-http",
    }));
  });

  it.each([
    "https://packages.example.invalid/alpha.tgz",
    "git+ssh://git@example.invalid/team/alpha.git#" + "a".repeat(40),
  ])("does not report the secure source %s as insecure", (spec) => {
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: spec } })],
      lock: parsedLock({ "": { dependencies: { alpha: spec } } }),
      internalPackages: [],
    });

    expect(result.matches).not.toContainEqual(expect.objectContaining({
      family: "insecure-source",
    }));
  });

  it("reports a mutable Git dependency without a full locked commit", () => {
    const spec = "github:owner/alpha#main";
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: spec } })],
      lock: parsedLock({
        "": { dependencies: { alpha: spec } },
        "node_modules/alpha": { resolved: "git+ssh://git@example.invalid/alpha.git#main" },
      }),
      internalPackages: [],
    });

    expect(result.matches).toContainEqual(expect.objectContaining({
      family: "mutable-git-source",
      packageName: "alpha",
      sourceClass: "git-mutable",
      severity: "medium",
      confidence: "high",
    }));
  });

  it("accepts a mutable manifest Git reference when lock evidence pins a full commit", () => {
    const spec = "github:owner/alpha#main";
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: spec } })],
      lock: parsedLock({
        "": { dependencies: { alpha: spec } },
        "node_modules/alpha": {
          resolved: "git+ssh://git@example.invalid/alpha.git#" + "a".repeat(40),
        },
      }),
      internalPackages: [],
    });

    expect(result.matches).not.toContainEqual(expect.objectContaining({
      family: "mutable-git-source",
    }));
  });

  it.each([undefined, "not-valid-integrity"])(
    "reports eligible HTTPS tarballs with invalid integrity %s",
    (integrity) => {
      const result = analyzeDependencyTarget({
        target: target(),
        manifests: [manifest("package.json", {})],
        lock: parsedLock({
          "": {},
          "node_modules/alpha": {
            resolved: "https://packages.example.invalid/alpha.tgz",
            ...(integrity === undefined ? {} : { integrity }),
          },
        }),
        internalPackages: [],
      });

      expect(result.matches).toContainEqual(expect.objectContaining({
        family: "missing-integrity",
        packageName: "alpha",
        severity: "medium",
        confidence: "high",
      }));
    },
  );

  it.each([
    "sha512-QUJDREVGRw==",
    "sha384-QUJDREVGRw==",
    "sha256-QUJDREVGRw==",
    "sha1-QUJDREVGRw==",
    "sha512-QUJDREVGRw== sha256-SElKS0w=",
  ])("accepts valid SRI evidence %s", (integrity) => {
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", {})],
      lock: parsedLock({
        "": {},
        "node_modules/alpha": {
          resolved: "https://packages.example.invalid/alpha.tgz",
          integrity,
        },
      }),
      internalPackages: [],
    });

    expect(result.matches).not.toContainEqual(expect.objectContaining({
      family: "missing-integrity",
    }));
  });

  it.each([
    { resolved: "packages/alpha", link: true },
    { resolved: "file:../alpha" },
    { resolved: "git+ssh://git@example.invalid/alpha.git#" + "a".repeat(40) },
    { resolved: "https://packages.example.invalid/metadata.json" },
    {},
  ])("does not require integrity for an ineligible lock entry", (entry) => {
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", {})],
      lock: parsedLock({ "": {}, "node_modules/alpha": entry }),
      internalPackages: [],
    });

    expect(result.matches).not.toContainEqual(expect.objectContaining({
      family: "missing-integrity",
    }));
  });

  it("accepts an internal workspace dependency linked to the detected member", () => {
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { shared: "^1.0.0" } })],
      lock: parsedLock({
        "": { dependencies: { shared: "^1.0.0" } },
        "node_modules/shared": { resolved: "packages/shared", link: true },
      }),
      internalPackages: [{ name: "shared", root: "packages/shared" }],
    });

    expect(result.matches).not.toContainEqual(expect.objectContaining({
      family: "workspace-registry-resolution",
    }));
  });

  it("reports an internal workspace name observed resolving to a registry package", () => {
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { shared: "^1.0.0" } })],
      lock: parsedLock({
        "": { dependencies: { shared: "^1.0.0" } },
        "node_modules/shared": {
          resolved: "https://packages.example.invalid/shared.tgz",
          integrity: "sha512-QUJDREVGRw==",
        },
      }),
      internalPackages: [{ name: "shared", root: "packages/shared" }],
    });

    expect(result.matches).toContainEqual(expect.objectContaining({
      family: "workspace-registry-resolution",
      packageName: "shared",
      severity: "high",
      confidence: "high",
    }));
  });

  it("withholds credentials from all source and integrity rule metadata", () => {
    const seed = ["dependency", "-url-", "credential-8Wm"].join("");
    const spec = `http://user:${seed}@example.invalid/alpha.tgz?token=${seed}`;
    const result = analyzeDependencyTarget({
      target: target(),
      manifests: [manifest("package.json", { dependencies: { alpha: spec } })],
      lock: parsedLock({
        "": { dependencies: { alpha: spec } },
        "node_modules/alpha": { resolved: spec },
      }),
      internalPackages: [],
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(seed);
  });
});
