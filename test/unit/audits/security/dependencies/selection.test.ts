import { describe, expect, it } from "vitest";
import { selectDependencyAuditTargets } from "../../../../../src/audits/security/dependencies/selection.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../../src/scope/types.js";
import type {
  DetectedProject,
  ManifestRecord,
  ProjectSnapshot,
} from "../../../../../src/workspace/types.js";

function file(path: string, kind: "file" | "symlink" = "file") {
  return { path, kind, size: 100 } as const;
}

function project(
  id: string,
  root: string,
  overrides: Partial<DetectedProject> = {},
): DetectedProject {
  return {
    id,
    root,
    ecosystems: ["node"],
    languages: ["javascript"],
    frameworks: [],
    dependencyNames: ["alpha"],
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported",
    ...overrides,
  };
}

function manifest(
  path: string,
  dependencies: Record<string, string> = { alpha: "1.0.0" },
  packageManager?: string,
): ManifestRecord {
  return {
    kind: "package-json",
    path,
    status: "valid",
    data: {
      dependencies,
      ...(packageManager === undefined ? {} : { packageManager }),
    },
  };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/repo",
    files: [],
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
    ...overrides,
  };
}

function changedScope(
  affectedProjectIds: readonly string[],
  changes: AuditScope["changes"] = [],
): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes,
    affectedProjectIds,
    reasons: [],
    limitations: [],
  };
}

describe("dependency audit target selection", () => {
  it("selects a standalone npm project and its package lock", () => {
    const root = project("root", ".", { packageManager: "npm" });
    const selection = selectDependencyAuditTargets(snapshot({
      files: [file("package.json"), file("package-lock.json")],
      manifests: [manifest("package.json")],
      projects: [root],
    }));

    expect(selection).toEqual({
      scope: "full",
      targets: [{
        lockRoot: ".",
        authority: "package-lock",
        lockOwnership: "governed",
        lockfile: file("package-lock.json"),
        coveredProjects: [{
          projectId: "root",
          root: ".",
          manifestPath: "package.json",
        }],
        competingLockfilePaths: [],
        limitations: [],
        scope: "full",
      }],
      unsupportedScopes: [],
      notApplicableScopes: [],
      limitations: [],
    });
  });

  it("uses shrinkwrap precedence and records a competing package lock", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [
        file("package-lock.json"),
        file("package.json"),
        file("npm-shrinkwrap.json"),
      ],
      manifests: [manifest("package.json")],
      projects: [project("root", ".", { packageManager: "npm" })],
    }));

    expect(selection.targets[0]).toMatchObject({
      authority: "shrinkwrap",
      lockfile: file("npm-shrinkwrap.json"),
      competingLockfilePaths: ["package-lock.json"],
    });
  });

  it("lets a root lock govern workspaces but keeps a nested lock independent", () => {
    const root = project("root", ".", { packageManager: "npm" });
    const api = project("project:packages/api", "packages/api");
    const web = project("project:packages/web", "packages/web", { packageManager: "npm" });
    const selection = selectDependencyAuditTargets(snapshot({
      files: [
        file("package.json"),
        file("package-lock.json"),
        file("packages/api/package.json"),
        file("packages/web/package.json"),
        file("packages/web/package-lock.json"),
      ],
      manifests: [
        manifest("package.json"),
        manifest("packages/api/package.json"),
        manifest("packages/web/package.json"),
      ],
      projects: [root, api, web],
      workspaces: [{
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "packages/*",
        supported: true,
        matchedProjectRoots: ["packages/api", "packages/web"],
      }],
    }));

    expect(selection.targets.map(({ lockRoot, coveredProjects }) => ({
      lockRoot,
      projects: coveredProjects.map(({ projectId }) => projectId),
    }))).toEqual([
      { lockRoot: ".", projects: ["root", "project:packages/api"] },
      { lockRoot: "packages/web", projects: ["project:packages/web"] },
    ]);
  });

  it("withholds missing-lock proof when a manifest-only manager is ambiguous", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [file("package.json")],
      manifests: [manifest("package.json")],
      projects: [project("root", ".")],
    }));

    expect(selection.targets[0]).toMatchObject({
      lockRoot: ".",
      authority: "none",
      lockOwnership: "unresolved",
      coveredProjects: [expect.objectContaining({ projectId: "root" })],
      limitations: [
        ".: npm lock ownership is unresolved; missing-lockfile analysis was withheld.",
      ],
    });
    expect(selection.targets[0]).not.toHaveProperty("lockfile");
  });

  it("requires a lock only for an explicitly npm-governed standalone project", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [file("package.json")],
      manifests: [manifest("package.json", { alpha: "1.0.0" }, "npm@11.0.0")],
      projects: [project("root", ".", { packageManager: "npm" })],
    }));

    expect(selection.targets).toEqual([expect.objectContaining({
      lockRoot: ".",
      authority: "none",
      lockOwnership: "explicit-standalone",
      limitations: [],
    })]);
  });

  it.each(["pnpm", "yarn"] as const)(
    "inherits an unsupported %s manager across nested publication packages",
    (packageManager) => {
      const lockName = packageManager === "pnpm" ? "pnpm-lock.yaml" : "yarn.lock";
      const root = project("root", ".", { packageManager });
      const child = project("child", "packages/child");
      const selection = selectDependencyAuditTargets(snapshot({
        files: [
          file("package.json"),
          file(lockName),
          file("packages/child/package.json"),
        ],
        manifests: [
          manifest("package.json"),
          manifest("packages/child/package.json"),
        ],
        projects: [root, child],
      }));

      expect(selection.targets).toEqual([]);
      expect(selection.unsupportedScopes).toEqual([
        { projectId: "root", root: ".", ecosystem: `node:${packageManager}` },
        { projectId: "child", root: "packages/child", ecosystem: `node:${packageManager}` },
      ]);
    },
  );

  it("withholds lockfile claims for a nested npm manifest outside a proven workspace", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [
        file("package.json"),
        file("package-lock.json"),
        file("packages/published/package.json"),
      ],
      manifests: [
        manifest("package.json", { alpha: "1.0.0" }, "npm@11.0.0"),
        manifest("packages/published/package.json"),
      ],
      projects: [
        project("root", ".", { packageManager: "npm" }),
        project("published", "packages/published"),
      ],
    }));

    expect(selection.targets).toEqual([
      expect.objectContaining({ lockRoot: ".", lockOwnership: "governed" }),
      expect.objectContaining({
        lockRoot: "packages/published",
        authority: "none",
        lockOwnership: "unresolved",
        limitations: [
          "packages/published: npm lock ownership is unresolved; missing-lockfile analysis was withheld.",
        ],
      }),
    ]);
  });

  it("reports unsupported ecosystems and dependency-free Node projects truthfully", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      projects: [
        project("pnpm", "pnpm", { packageManager: "pnpm" }),
        project("python", "python", {
          ecosystems: ["python"],
          languages: ["python"],
          dependencyNames: [],
          manifestPaths: ["python/pyproject.toml"],
        }),
        project("empty", "empty", { dependencyNames: [] }),
      ],
    }));

    expect(selection.targets).toEqual([]);
    expect(selection.unsupportedScopes).toEqual([
      { projectId: "pnpm", root: "pnpm", ecosystem: "node:pnpm" },
      { projectId: "python", root: "python", ecosystem: "python" },
    ]);
    expect(selection.notApplicableScopes).toEqual([
      { projectId: "empty", root: "empty" },
    ]);
  });

  it("surfaces invalid manifests, symlink locks, and unsupported workspace patterns", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [file("package.json"), file("package-lock.json", "symlink")],
      manifests: [{
        kind: "package-json",
        path: "package.json",
        status: "invalid",
        error: "seeded parser detail must not escape",
      }],
      projects: [project("root", ".", { packageManager: "npm" })],
      workspaces: [{
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "packages/**/nested/*",
        supported: false,
        matchedProjectRoots: [],
      }],
    }));

    expect(selection.targets[0]).toMatchObject({ authority: "none" });
    expect(selection.limitations).toEqual([
      "package-lock.json: selected npm lockfile is not an inventoried regular file.",
      "package.json: invalid package manifest limits dependency analysis.",
      "package.json: unsupported workspace pattern limits dependency lock ownership.",
    ]);
    expect(JSON.stringify(selection)).not.toContain("seeded parser detail");
  });

  it("selects only affected projects and their governing lock in changed mode", () => {
    const root = project("root", ".", { packageManager: "npm" });
    const api = project("api", "packages/api");
    const web = project("web", "packages/web");
    const selection = selectDependencyAuditTargets(snapshot({
      files: [
        file("package.json"),
        file("package-lock.json"),
        file("packages/api/package.json"),
        file("packages/web/package.json"),
      ],
      manifests: [
        manifest("package.json"),
        manifest("packages/api/package.json"),
        manifest("packages/web/package.json"),
      ],
      projects: [root, api, web],
      workspaces: [{
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "packages/*",
        supported: true,
        matchedProjectRoots: ["packages/api", "packages/web"],
      }],
      auditScope: changedScope(["api"], [{ status: "modified", path: "packages/api/src/app.ts" }]),
    }));

    expect(selection.scope).toBe("changed");
    expect(selection.targets).toEqual([expect.objectContaining({
      lockRoot: ".",
      scope: "changed",
      coveredProjects: [{
        projectId: "api",
        root: "packages/api",
        manifestPath: "packages/api/package.json",
      }],
    })]);
  });

  it("returns no selected target for unrelated changed scope", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [file("package.json"), file("package-lock.json")],
      manifests: [manifest("package.json")],
      projects: [project("root", ".", { packageManager: "npm" })],
      auditScope: changedScope([], [{ status: "modified", path: "README.md" }]),
    }));

    expect(selection).toMatchObject({
      scope: "changed",
      targets: [],
      unsupportedScopes: [],
      notApplicableScopes: [],
    });
  });

  it("sorts independent targets by lock root", () => {
    const selection = selectDependencyAuditTargets(snapshot({
      files: [
        file("z/package.json"),
        file("z/package-lock.json"),
        file("a/package.json"),
        file("a/package-lock.json"),
      ],
      manifests: [manifest("z/package.json"), manifest("a/package.json")],
      projects: [
        project("z", "z", { packageManager: "npm" }),
        project("a", "a", { packageManager: "npm" }),
      ],
    }));

    expect(selection.targets.map(({ lockRoot }) => lockRoot)).toEqual(["a", "z"]);
  });
});
