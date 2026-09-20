import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createDependenciesDoctor } from "../../../../../src/audits/security/dependencies/doctor.js";
import { analyzeCrossEcosystemTarget, selectCrossEcosystemTargets } from "../../../../../src/audits/security/dependencies/ecosystems.js";
import { parseNodeLock } from "../../../../../src/audits/security/dependencies/node-locks.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../../src/scope/types.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";

function nodeProject(packageManager: "pnpm" | "yarn" | "bun", root = ".") {
  return {
    id: "root",
    root,
    ecosystems: ["node"],
    languages: ["typescript"],
    frameworks: [],
    packageManager,
    packageName: "fixture",
    dependencyNames: ["alpha"],
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported" as const,
  };
}

function snapshot(
  files: readonly { path: string; size?: number }[],
  manifests: ProjectSnapshot["manifests"],
  project = nodeProject("pnpm"),
  auditScope: AuditScope = fullAuditScope(),
): ProjectSnapshot {
  return {
    root: "/repo",
    files: files.map(({ path, size = 100 }) => ({ path, kind: "file" as const, size })),
    manifests,
    projects: [project],
    workspaces: [],
    auditScope,
  };
}

const PNPM_LOCK = [
  "lockfileVersion: '9.0'",
  "importers:",
  "  .:",
  "    dependencies:",
  "      alpha:",
  "        specifier: ^1.0.0",
  "        version: 1.0.0",
  "packages:",
  "  alpha@1.0.0:",
  "    resolution: {integrity: sha512-abc}",
  "  gamma@2.0.0:",
  "    resolution: {tarball: http://example.invalid/gamma-2.0.0.tgz}",
  "  delta@3.0.0: {}",
  "  beta@github.com/user/beta/main:",
  "    resolution: {repo: https://github.com/user/beta.git, commit: 0123456789abcdef0123456789abcdef01234567, type: git}",
  "  epsilon@1.0.0:",
  "    resolution: {repo: https://github.com/user/epsilon.git, type: git}",
  "",
].join("\n");

describe("cross-ecosystem node lock parsing", () => {
  it("extracts pnpm specifiers, integrity, git pinning, and insecure tarballs", () => {
    const summary = parseNodeLock("pnpm-lock.yaml", PNPM_LOCK);
    expect(summary?.format).toBe("pnpm");
    expect(summary?.specifiersRecorded).toBe(true);
    expect(summary?.directSpecifiersComplete).toBe(true);
    expect(summary?.specifiers.get(".")?.get("alpha")).toEqual(["^1.0.0"]);
    const byName = new Map(summary?.packages.map((entry) => [entry.name, entry]));
    expect(byName.get("alpha")).toMatchObject({ integrity: "present", sourceClass: "registry" });
    expect(byName.get("gamma")).toMatchObject({ sourceClass: "insecure-http", integrity: "missing" });
    expect(byName.get("delta")).toMatchObject({ integrity: "missing" });
    expect(byName.get("beta")).toMatchObject({ sourceClass: "git-pinned" });
    expect(byName.get("epsilon")).toMatchObject({ sourceClass: "git-mutable" });
  });

  it("extracts yarn v1 integrity, git mutability, and descriptor ranges", () => {
    const content = [
      "# yarn lockfile v1",
      "",
      '"alpha@^1.0.0":',
      '  version "1.0.0"',
      '  resolved "https://registry.yarnpkg.com/alpha/-/alpha-1.0.0.tgz#0123456789abcdef0123456789abcdef01234567"',
      "",
      '"beta@github:user/beta#main":',
      '  version "0.0.0"',
      '  resolved "https://github.com/user/beta.git#main"',
      "",
      '"gamma@^2.0.0":',
      '  version "2.0.0"',
      '  resolved "https://registry.yarnpkg.com/gamma/-/gamma-2.0.0.tgz"',
      "",
    ].join("\n");
    const summary = parseNodeLock("yarn.lock", content);
    expect(summary?.format).toBe("yarn-v1");
    expect(summary?.directSpecifiersComplete).toBe(false);
    expect(summary?.specifiers.get(".")?.get("alpha")).toEqual(["^1.0.0"]);
    const byName = new Map(summary?.packages.map((entry) => [entry.name, entry]));
    expect(byName.get("alpha")).toMatchObject({ integrity: "present" });
    expect(byName.get("beta")).toMatchObject({ sourceClass: "git-mutable" });
    expect(byName.get("gamma")).toMatchObject({ integrity: "missing" });
  });

  it("extracts yarn berry checksums and git commit pinning", () => {
    const content = [
      "__metadata:",
      "  version: 8",
      '"alpha@npm:^1.0.0":',
      "  version: 1.0.0",
      '  resolution: "alpha@npm:1.0.0"',
      "  checksum: 10c0/abc",
      '"beta@npm:^2.0.0":',
      "  version: 2.0.0",
      '  resolution: "beta@npm:2.0.0"',
      '"gamma@npm:git+https://github.com/user/gamma.git#commit=0123456789abcdef0123456789abcdef01234567":',
      "  version: 0.0.0",
      '  resolution: "gamma@git:https://github.com/user/gamma.git#commit=0123456789abcdef0123456789abcdef01234567"',
      "",
    ].join("\n");
    const summary = parseNodeLock("yarn.lock", content);
    expect(summary?.format).toBe("yarn-berry");
    const byName = new Map(summary?.packages.map((entry) => [entry.name, entry]));
    expect(byName.get("alpha")).toMatchObject({ integrity: "present", sourceClass: "registry" });
    expect(byName.get("beta")).toMatchObject({ integrity: "missing" });
    expect(byName.get("gamma")).toMatchObject({ sourceClass: "git-pinned" });
  });

  it("extracts bun workspace specifiers and array integrity", () => {
    const content = [
      "{",
      '  "lockfileVersion": 1,',
      '  "workspaces": { "": { "name": "fixture", "dependencies": { "alpha": "^1.0.0" } } },',
      '  "packages": {',
      '    "alpha@1.0.0": ["alpha@1.0.0", "", {}, "sha512-abc"],',
      '    "beta@2.0.0": ["beta@2.0.0", "", {}],',
      '    "gamma@git+https://github.com/user/gamma.git#main": ["gamma@git+https://github.com/user/gamma.git#main", "", {}],',
      "  },",
      "}",
      "",
    ].join("\n");
    const summary = parseNodeLock("bun.lock", content);
    expect(summary?.format).toBe("bun");
    expect(summary?.directSpecifiersComplete).toBe(true);
    expect(summary?.specifiers.get(".")?.get("alpha")).toEqual(["^1.0.0"]);
    const byName = new Map(summary?.packages.map((entry) => [entry.name, entry]));
    expect(byName.get("alpha")).toMatchObject({ integrity: "present" });
    expect(byName.get("beta")).toMatchObject({ integrity: "missing" });
    expect(byName.get("gamma")).toMatchObject({ sourceClass: "git-mutable" });
  });
});

describe("cross-ecosystem dependency analysis", () => {
  it("selects pnpm projects and reports drift, lock evidence, and competing locks", () => {
    const project = nodeProject("pnpm");
    const selection = selectCrossEcosystemTargets(snapshot(
      [{ path: "package.json" }, { path: "pnpm-lock.yaml" }, { path: "package-lock.json" }],
      [{ kind: "package-json", path: "package.json", status: "valid", data: { dependencies: { alpha: "1.5.0" } } }],
      project,
    ));

    expect(selection.handledProjectIds.has("root")).toBe(true);
    expect(selection.targets).toHaveLength(1);
    const target = selection.targets[0]!;
    expect(target.lockRoot).toBe(".");
    expect(target.manager).toBe("pnpm");
    expect(target.competingLockfilePaths).toEqual(["package-lock.json"]);

    const lock = parseNodeLock("pnpm-lock.yaml", PNPM_LOCK);
    const analysis = analyzeCrossEcosystemTarget({
      target,
      ...(lock === undefined ? {} : { lock }),
      manifests: [{ kind: "package-json", path: "package.json", status: "valid", data: { dependencies: { alpha: "1.5.0" } } }],
      internalNames: new Set(),
    });

    const families = analysis.matches.map((match) => match.family);
    expect(families).toContain("manifest-lock-drift");
    expect(families).toContain("insecure-source");
    expect(families).toContain("missing-integrity");
    expect(families).toContain("mutable-git-source");
    expect(families).toContain("competing-lockfiles");
  });

  it("reports missing-lockfile for a declared manager without a lockfile", async () => {
    const project = nodeProject("pnpm");
    const selection = selectCrossEcosystemTargets(snapshot(
      [{ path: "package.json" }],
      [{ kind: "package-json", path: "package.json", status: "valid", data: { dependencies: { alpha: "^1.0.0" } } }],
      project,
    ));
    expect(selection.targets[0]?.lockfile).toBeUndefined();

    const analysis = analyzeCrossEcosystemTarget({
      target: selection.targets[0]!,
      manifests: [{ kind: "package-json", path: "package.json", status: "valid", data: { dependencies: { alpha: "^1.0.0" } } }],
      internalNames: new Set(),
    });
    expect(analysis.matches).toEqual([
      expect.objectContaining({ family: "missing-lockfile", path: "package.json" }),
    ]);
  });

  it("covers pnpm projects in the doctor instead of reporting them unsupported", async () => {
    const readFile = vi.fn(async () => Buffer.from(PNPM_LOCK));
    const doctor = createDependenciesDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: snapshot(
        [{ path: "package.json" }, { path: "pnpm-lock.yaml" }],
        [{ kind: "package-json", path: "package.json", status: "valid", data: { dependencies: { alpha: "^1.0.0" } } }],
        nodeProject("pnpm"),
      ),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining([
      "security/dependencies/insecure-source",
      "security/dependencies/missing-integrity",
    ]));
    expect(result.findings.every((finding) => finding.doctorId === "security/dependencies")).toBe(true);
    expect(result.coverage ?? []).toContainEqual(expect.objectContaining({
      moduleId: "security/dependencies",
      scope: "full:.:pnpm",
      status: "completed",
      filesExamined: 2,
      statementsExamined: 5,
    }));
    expect((result.coverage ?? []).some((entry) => entry.status === "unsupported")).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain(
      "security/dependencies/manifest-lock-drift",
    );
  });
});
