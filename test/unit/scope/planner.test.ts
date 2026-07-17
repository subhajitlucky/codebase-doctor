import { describe, expect, expectTypeOf, it } from "vitest";
import { fullAuditScope, planChangedScope } from "../../../src/scope/planner.js";
import type {
  AuditBase,
  AuditScope,
  ChangedPath,
} from "../../../src/scope/types.js";
import type { DetectedProject } from "../../../src/workspace/types.js";

const base: AuditBase = {
  kind: "merge-base",
  requestedRef: "main",
  resolvedCommit: "0123456789abcdef",
};

function project(
  root: string,
  metadata: Pick<DetectedProject, "packageName" | "dependencyNames"> = {},
): DetectedProject {
  return {
    id: root === "." ? "root" : `project:${root}`,
    root,
    ecosystems: ["node"],
    languages: ["javascript"],
    frameworks: [],
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported",
    ...metadata,
  };
}

function change(
  path: string,
  status: ChangedPath["status"] = "modified",
  previousPath?: string,
): ChangedPath {
  return { status, path, ...(previousPath === undefined ? {} : { previousPath }) };
}

describe("planChangedScope", () => {
  it("assigns exact-root and nested paths to the deepest containing project", () => {
    const projects = [project("."), project("apps"), project("apps/web")];
    const scope = planChangedScope(base, [
      change("apps/web"),
      change("apps/web/src/index.ts"),
    ], projects);

    expect(scope.affectedProjectIds).toEqual(["project:apps/web"]);
    expect(scope.reasons).toEqual([
      {
        projectId: "project:apps/web",
        reason: "direct-change",
        source: "apps/web",
      },
      {
        projectId: "project:apps/web",
        reason: "direct-change",
        source: "apps/web/src/index.ts",
      },
    ]);
  });

  it("uses a repository-root project as the fallback owner", () => {
    const scope = planChangedScope(base, [change("scripts/release.ts")], [
      project("."),
      project("apps/web"),
    ]);

    expect(scope.affectedProjectIds).toEqual(["root"]);
    expect(scope.reasons).toEqual([{
      projectId: "root",
      reason: "direct-change",
      source: "scripts/release.ts",
    }]);
  });

  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".yarnrc.yml",
    "bunfig.toml",
    "tsconfig.base.json",
    ".codebase-doctor.json",
    "pyproject.toml",
  ])("treats the root-context file %s as affecting every project", (path) => {
    const scope = planChangedScope(base, [change(path)], [
      project("packages/ui"),
      project("apps/web"),
    ]);

    expect(scope.affectedProjectIds).toEqual(["project:apps/web", "project:packages/ui"]);
    expect(scope.reasons).toEqual([
      { projectId: "project:apps/web", reason: "root-context", source: path },
      { projectId: "project:packages/ui", reason: "root-context", source: path },
    ]);
  });

  it("propagates direct changes through transitive reverse workspace dependencies", () => {
    const ui = project("packages/ui", {
      packageName: "@example/ui",
      dependencyNames: [],
    });
    const web = project("apps/web", {
      packageName: "@example/web",
      dependencyNames: ["@example/ui", "react"],
    });
    const shell = project("apps/shell", {
      packageName: "@example/shell",
      dependencyNames: ["@example/web"],
    });

    const scope = planChangedScope(base, [change("packages/ui/src/button.ts")], [
      shell,
      ui,
      web,
    ]);

    expect(scope.affectedProjectIds).toEqual([
      "project:apps/shell",
      "project:apps/web",
      "project:packages/ui",
    ]);
    expect(scope.reasons).toEqual([
      {
        projectId: "project:apps/shell",
        reason: "workspace-dependent",
        source: "@example/web -> @example/shell",
      },
      {
        projectId: "project:apps/web",
        reason: "workspace-dependent",
        source: "@example/ui -> @example/web",
      },
      {
        projectId: "project:packages/ui",
        reason: "direct-change",
        source: "packages/ui/src/button.ts",
      },
    ]);
    expect(scope.limitations).toEqual([]);
  });

  it("is cycle-safe and emits deterministic, deduplicated reasons", () => {
    const first = project("packages/a", {
      packageName: "a",
      dependencyNames: ["b"],
    });
    const second = project("packages/b", {
      packageName: "b",
      dependencyNames: ["a", "a"],
    });
    const changes = [change("packages/a/a.ts"), change("packages/a/a.ts")];

    const forward = planChangedScope(base, changes, [second, first]);
    const reverse = planChangedScope(base, [...changes].reverse(), [first, second]);

    expect(forward).toEqual(reverse);
    expect(forward.affectedProjectIds).toEqual(["project:packages/a", "project:packages/b"]);
    expect(forward.reasons).toEqual([
      {
        projectId: "project:packages/a",
        reason: "direct-change",
        source: "packages/a/a.ts",
      },
      {
        projectId: "project:packages/b",
        reason: "workspace-dependent",
        source: "a -> b",
      },
    ]);
  });

  it("does not invent edges for ambiguous duplicate package names", () => {
    const scope = planChangedScope(base, [change("packages/one/index.ts")], [
      project("packages/one", { packageName: "shared", dependencyNames: [] }),
      project("packages/two", { packageName: "shared", dependencyNames: [] }),
      project("apps/web", { packageName: "web", dependencyNames: ["shared"] }),
    ]);

    expect(scope.affectedProjectIds).toEqual(["project:packages/one"]);
    expect(scope.limitations).toEqual([
      'Package name "shared" is declared by multiple projects: project:packages/one, project:packages/two; dependency propagation for that name was skipped.',
    ]);
  });

  it("discloses unnamed Node projects without flagging external dependency names", () => {
    const scope = planChangedScope(base, [change("packages/ui/index.ts")], [
      project("packages/ui"),
      project("apps/web", {
        packageName: "web",
        dependencyNames: ["@missing/internal", "react"],
      }),
    ]);

    expect(scope.affectedProjectIds).toEqual(["project:packages/ui"]);
    expect(scope.limitations).toEqual([
      'Node project "project:packages/ui" has no valid package name; it cannot be identified as an internal dependency target.',
    ]);
  });

  it("does not report package metadata limitations for non-Node projects", () => {
    const python = {
      ...project("services/api"),
      ecosystems: ["python"],
      languages: ["python"],
    } satisfies DetectedProject;

    const scope = planChangedScope(base, [change("services/api/app.py")], [python]);

    expect(scope.limitations).toEqual([]);
  });

  it("distinguishes unavailable dependency metadata from a known empty dependency set", () => {
    const scope = planChangedScope(base, [change("packages/unknown/index.ts")], [
      project("packages/unknown", { packageName: "@example/unknown" }),
      project("packages/leaf", {
        packageName: "@example/leaf",
        dependencyNames: [],
      }),
    ]);

    expect(scope.limitations).toEqual([
      'Node project "project:packages/unknown" (@example/unknown) has unavailable dependency metadata; reverse workspace dependency relationships may be incomplete.',
    ]);
  });

  it("uses both the old and new paths of a rename for direct ownership", () => {
    const scope = planChangedScope(
      base,
      [change("apps/web/new.ts", "renamed", "packages/ui/old.ts")],
      [project("apps/web"), project("packages/ui")],
    );

    expect(scope.affectedProjectIds).toEqual([
      "project:apps/web",
      "project:packages/ui",
    ]);
    expect(scope.reasons).toEqual([
      {
        projectId: "project:apps/web",
        reason: "direct-change",
        source: "apps/web/new.ts",
      },
      {
        projectId: "project:packages/ui",
        reason: "direct-change",
        source: "packages/ui/old.ts",
      },
    ]);
  });

  it("scopes a copy by its destination while retaining its source metadata", () => {
    const copied = change("packages/ui/copy.ts", "copied", "package.json");
    const scope = planChangedScope(base, [copied], [
      project("apps/web"),
      project("packages/ui"),
    ]);

    expect(scope.changes).toEqual([copied]);
    expect(scope.affectedProjectIds).toEqual(["project:packages/ui"]);
    expect(scope.reasons).toEqual([{
      projectId: "project:packages/ui",
      reason: "direct-change",
      source: "packages/ui/copy.ts",
    }]);
  });

  it("maps a deleted path by its path text", () => {
    const scope = planChangedScope(base, [change("apps/api/deleted.ts", "deleted")], [
      project("apps/api"),
    ]);

    expect(scope.reasons).toEqual([{
      projectId: "project:apps/api",
      reason: "direct-change",
      source: "apps/api/deleted.ts",
    }]);
  });

  it("treats literal backslashes as filename data, not POSIX separators", () => {
    const scope = planChangedScope(base, [
      change("apps\\web/file.ts"),
      change("folder\\package.json"),
    ], [
      project("apps", { packageName: "apps", dependencyNames: [] }),
      project("packages/ui", { packageName: "ui", dependencyNames: [] }),
    ]);

    expect(scope.affectedProjectIds).toEqual([]);
    expect(scope.reasons).toEqual([]);
  });

  it("returns a deterministic empty changed scope without mutating inputs", () => {
    const changes: readonly ChangedPath[] = [];
    const projects = [
      project("apps/web", { packageName: "duplicate", dependencyNames: [] }),
      project("packages/ui", { packageName: "duplicate", dependencyNames: [] }),
    ];

    const scope = planChangedScope(base, changes, projects);

    expect(scope).toEqual({
      mode: "changed",
      base,
      changes: [],
      affectedProjectIds: [],
      reasons: [],
      limitations: [],
    });
    expect(projects).toEqual([
      project("apps/web", { packageName: "duplicate", dependencyNames: [] }),
      project("packages/ui", { packageName: "duplicate", dependencyNames: [] }),
    ]);
    expectTypeOf(scope).toEqualTypeOf<AuditScope>();
    expectTypeOf(scope.changes).toEqualTypeOf<readonly ChangedPath[]>();
  });
});

describe("fullAuditScope", () => {
  it("returns an immutable full scope with no base or selections", () => {
    const scope = fullAuditScope();

    expect(scope).toEqual({
      mode: "full",
      base: null,
      changes: [],
      affectedProjectIds: [],
      reasons: [],
      limitations: [],
    });
    expectTypeOf(scope).toEqualTypeOf<AuditScope>();
    expectTypeOf(scope.affectedProjectIds).toEqualTypeOf<readonly string[]>();
  });
});
