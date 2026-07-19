import { describe, expect, it } from "vitest";
import {
  selectDrizzleAuditFiles,
  type DrizzleSelectionOptions,
} from "../../../../../src/audits/database/drizzle/selection.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../../src/scope/types.js";
import type {
  DetectedProject,
  ProjectSnapshot,
} from "../../../../../src/workspace/types.js";

function file(path: string, kind: "file" | "symlink" = "file") {
  return { path, kind, size: 100 } as const;
}

function project(
  id: string,
  root: string,
  dependencyNames: readonly string[] | undefined,
): DetectedProject {
  return {
    id,
    root,
    ecosystems: ["node"],
    languages: ["typescript"],
    frameworks: [],
    ...(dependencyNames === undefined ? {} : { dependencyNames }),
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported",
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
  changes: AuditScope["changes"],
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

function select(
  value: ProjectSnapshot,
  options: DrizzleSelectionOptions = {},
) {
  return selectDrizzleAuditFiles(value, options);
}

describe("Drizzle audit file selection", () => {
  it("selects supported source owned by a project with postgres-js dependency evidence", () => {
    const selection = select(snapshot({
      files: [
        file("src/z.ts"),
        file("src/a.tsx"),
        file("src/view.jsx"),
        file("src/old.js"),
        file("src/types.d.ts"),
        file("src/readme.md"),
        file("src/link.ts", "symlink"),
      ],
      projects: [project("root", ".", ["postgres", "drizzle-orm"])],
    }));

    expect(selection).toEqual({
      scope: "full",
      applicableProjectIds: ["root"],
      files: [
        file("src/a.tsx"),
        file("src/old.js"),
        file("src/types.d.ts"),
        file("src/view.jsx"),
        file("src/z.ts"),
      ],
      limitations: [],
    });
  });

  it("does not treat either dependency by itself as proof", () => {
    const selection = select(snapshot({
      files: [file("apps/a/src/a.ts"), file("apps/b/src/b.ts")],
      projects: [
        project("a", "apps/a", ["drizzle-orm"]),
        project("b", "apps/b", ["postgres"]),
      ],
    }));

    expect(selection.applicableProjectIds).toEqual([]);
    expect(selection.files).toEqual([]);
    expect(selection.limitations).toEqual([]);
  });

  it("combines member and supported workspace-owner dependency evidence", () => {
    const root = project("root", ".", ["postgres"]);
    const api = project("api", "apps/api", ["drizzle-orm"]);
    const selection = select(snapshot({
      files: [file("apps/api/src/query.ts"), file("src/root.ts")],
      projects: [root, api],
      workspaces: [{
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "apps/*",
        supported: true,
        matchedProjectRoots: ["apps/api"],
      }],
    }));

    expect(selection.applicableProjectIds).toEqual(["api"]);
    expect(selection.files.map(({ path }) => path)).toEqual(["apps/api/src/query.ts"]);
  });

  it("does not invent unsupported workspace matches and exposes the unresolved boundary", () => {
    const root = project("root", ".", ["postgres"]);
    const api = project("api", "apps/api", ["drizzle-orm"]);
    const selection = select(snapshot({
      files: [file("apps/api/src/query.ts")],
      projects: [root, api],
      workspaces: [{
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "apps/**/api",
        supported: false,
        matchedProjectRoots: [],
      }],
    }));

    expect(selection.applicableProjectIds).toEqual([]);
    expect(selection.files).toEqual([]);
    expect(selection.limitations).toEqual([
      "package.json: unsupported workspace boundary prevents complete Drizzle applicability analysis.",
    ]);
  });

  it("limits unsupported workspace warnings to relevant in-scope dependency evidence", () => {
    const root = project("root", ".", ["postgres"]);
    const api = project("api", "apps/api", ["drizzle-orm"]);
    const workspace = {
      ownerProjectId: "root",
      sourcePath: "package.json",
      pattern: "apps/**",
      supported: false,
      matchedProjectRoots: [],
    } as const;
    const value = snapshot({ projects: [root, api], workspaces: [workspace] });

    expect(select(value).limitations).toEqual([
      "package.json: unsupported workspace boundary prevents complete Drizzle applicability analysis.",
    ]);
    expect(select({
      ...value,
      auditScope: changedScope(["root"], []),
    }).limitations).toEqual([]);
    expect(select({
      ...value,
      auditScope: changedScope(["api"], []),
    }).limitations).toEqual([
      "package.json: unsupported workspace boundary prevents complete Drizzle applicability analysis.",
    ]);
    const unrelated = select(snapshot({
      projects: [root, project("api", "apps/api", ["unrelated"])],
      workspaces: [workspace],
    }));
    expect(unrelated).toMatchObject({ limitations: [] });
  });

  it("accepts parser-proven drizzle-orm/postgres-js import evidence for its owner", () => {
    const selection = select(snapshot({
      files: [file("services/api/db.ts"), file("services/api/query.ts")],
      projects: [project("api", "services/api", [])],
    }), { postgresJsImportPaths: ["services/api/db.ts"] });

    expect(selection.applicableProjectIds).toEqual(["api"]);
    expect(selection.files.map(({ path }) => path)).toEqual([
      "services/api/db.ts",
      "services/api/query.ts",
    ]);
  });

  it("does not accept import evidence from a missing, unsupported, or unowned path", () => {
    const selection = select(snapshot({
      files: [file("README.md"), file("orphan.ts")],
      projects: [project("api", "services/api", [])],
    }), {
      postgresJsImportPaths: ["missing.ts", "README.md", "orphan.ts"],
    });

    expect(selection.applicableProjectIds).toEqual([]);
    expect(selection.limitations).toEqual([
      "README.md: postgres-js import evidence is outside supported source selection.",
      "missing.ts: postgres-js import evidence is not an inventoried regular file.",
      "orphan.ts: postgres-js import evidence has no unambiguous project owner.",
    ]);
  });

  it("uses the deepest unique project owner and reports ambiguous ownership", () => {
    const selection = select(snapshot({
      files: [file("packages/api/query.ts"), file("root.ts")],
      projects: [
        project("root", ".", ["drizzle-orm", "postgres"]),
        project("api-a", "packages/api", ["drizzle-orm", "postgres"]),
        project("api-b", "packages/api", ["drizzle-orm", "postgres"]),
      ],
    }));

    expect(selection.applicableProjectIds).toEqual(["api-a", "api-b", "root"]);
    expect(selection.files.map(({ path }) => path)).toEqual(["root.ts"]);
    expect(selection.limitations).toEqual([
      "packages/api/query.ts: source ownership is ambiguous; Drizzle analysis was withheld.",
    ]);
  });

  it("in changed scope selects only current supported changes owned by applicable affected projects", () => {
    const selection = select(snapshot({
      files: [
        file("apps/api/src/changed.ts"),
        file("apps/api/src/unchanged.ts"),
        file("apps/web/src/changed.ts"),
      ],
      projects: [
        project("api", "apps/api", ["drizzle-orm", "postgres"]),
        project("web", "apps/web", ["drizzle-orm", "postgres"]),
      ],
      auditScope: changedScope(["api"], [
        { status: "modified", path: "apps/api/src/changed.ts" },
        { status: "modified", path: "apps/web/src/changed.ts" },
      ]),
    }));

    expect(selection.applicableProjectIds).toEqual(["api"]);
    expect(selection.files.map(({ path }) => path)).toEqual(["apps/api/src/changed.ts"]);
    expect(selection.limitations).toEqual([
      "apps/web/src/changed.ts: changed source is outside an applicable affected Drizzle project.",
    ]);
  });

  it("silently skips ordinary changed source owned by a definitively non-Drizzle project", () => {
    const selection = select(snapshot({
      files: [
        file("apps/web/src/view.ts"),
        file("apps/web/src/link.ts", "symlink"),
        file("apps/web/README.md"),
      ],
      projects: [project("web", "apps/web", ["react"])],
      auditScope: changedScope(["web"], [
        { status: "modified", path: "apps/web/src/view.ts" },
        { status: "modified", path: "apps/web/src/missing.ts" },
        { status: "modified", path: "apps/web/src/link.ts" },
        { status: "modified", path: "apps/web/README.md" },
      ]),
    }));

    expect(selection).toMatchObject({
      applicableProjectIds: [],
      files: [],
      limitations: [],
    });
  });

  it("reports unknown dependency evidence only for in-scope Node projects", () => {
    const missing = project("missing", "apps/missing", undefined);
    const invalid = project("invalid", "apps/invalid", undefined);
    const outOfScope = project("out", "apps/out", undefined);
    const nonNode: DetectedProject = {
      ...project("python", "services/python", undefined),
      ecosystems: ["python"],
      languages: ["python"],
    };
    const selection = select(snapshot({
      projects: [missing, invalid, outOfScope, nonNode],
      manifests: [{
        kind: "package-json",
        path: "apps/invalid/package.json",
        status: "invalid",
        error: "invalid JSON",
      }],
      auditScope: changedScope(["missing", "invalid", "python"], []),
    }));

    expect(selection.limitations).toEqual([
      "apps/invalid/package.json: invalid dependency manifest prevents complete Drizzle applicability analysis for project invalid.",
      "apps/missing: dependency metadata is unavailable; Drizzle applicability is unknown for project missing.",
    ]);
  });

  it("treats explicit empty dependencies or a usable empty manifest as known non-applicable", () => {
    const explicit = project("explicit", "apps/explicit", []);
    const manifestBacked = project("manifest", "apps/manifest", undefined);
    const selection = select(snapshot({
      projects: [explicit, manifestBacked],
      manifests: [{
        kind: "package-json",
        path: "apps/manifest/package.json",
        status: "valid",
        data: { name: "manifest-backed" },
      }],
    }));

    expect(selection).toMatchObject({
      applicableProjectIds: [],
      files: [],
      limitations: [],
    });
  });

  it("reports deleted, missing, symlink, unsupported, and unowned changed paths without selecting them", () => {
    const selection = select(snapshot({
      files: [
        file("app/src/link.ts", "symlink"),
        file("app/README.md"),
        file("orphan.ts"),
      ],
      projects: [project("app", "app", ["drizzle-orm", "postgres"])],
      auditScope: changedScope(["app"], [
        { status: "deleted", path: "app/src/deleted.ts" },
        { status: "modified", path: "app/src/missing.ts" },
        { status: "modified", path: "app/src/link.ts" },
        { status: "modified", path: "app/README.md" },
        { status: "modified", path: "orphan.ts" },
      ]),
    }));

    expect(selection.files).toEqual([]);
    expect(selection.limitations).toEqual([
      "app/README.md: changed path is not a supported JavaScript or TypeScript source file.",
      "app/src/deleted.ts: deleted changed source could not be examined.",
      "app/src/link.ts: changed path is not an inventoried regular file.",
      "app/src/missing.ts: changed path is not an inventoried regular file.",
      "orphan.ts: changed source has no unambiguous project owner.",
    ]);
  });

  it("reports deletions only when an applicable affected owner loses auditable source", () => {
    const selection = select(snapshot({
      projects: [
        project("api", "apps/api", ["drizzle-orm", "postgres"]),
        project("web", "apps/web", ["react"]),
        project("worker", "apps/worker", ["drizzle-orm", "postgres"]),
      ],
      auditScope: changedScope(["api", "web"], [
        { status: "deleted", path: "apps/api/query.ts" },
        { status: "deleted", path: "apps/web/view.ts" },
        { status: "deleted", path: "apps/worker/job.ts" },
        { status: "deleted", path: "orphan.ts" },
      ]),
    }));

    expect(selection.applicableProjectIds).toEqual(["api"]);
    expect(selection.limitations).toEqual([
      "apps/api/query.ts: deleted changed source could not be examined.",
    ]);
  });

  it("reports an ambiguous deletion only when a deepest candidate is applicable", () => {
    const selection = select(snapshot({
      projects: [
        project("api-a", "apps/api", ["drizzle-orm", "postgres"]),
        project("api-b", "apps/api", ["react"]),
        project("web-a", "apps/web", ["react"]),
        project("web-b", "apps/web", ["react"]),
      ],
      auditScope: changedScope(["api-a", "api-b", "web-a", "web-b"], [
        { status: "deleted", path: "apps/api/query.ts" },
        { status: "deleted", path: "apps/web/view.ts" },
      ]),
    }));

    expect(selection.limitations).toEqual([
      "apps/api/query.ts: deleted changed source has ambiguous applicable ownership; analysis was withheld.",
    ]);
  });

  it("selects a rename under its current applicable affected owner and records loss from the old owner", () => {
    const selection = select(snapshot({
      files: [file("apps/api/new.ts"), file("apps/web/new.ts")],
      projects: [
        project("api", "apps/api", ["drizzle-orm", "postgres"]),
        project("web", "apps/web", ["react"]),
      ],
      auditScope: changedScope(["api", "web"], [
        {
          status: "renamed",
          path: "apps/api/new.ts",
          previousPath: "apps/web/old.ts",
        },
        {
          status: "renamed",
          path: "apps/web/new.ts",
          previousPath: "apps/api/old.ts",
        },
      ]),
    }));

    expect(selection.files.map(({ path }) => path)).toEqual(["apps/api/new.ts"]);
    expect(selection.limitations).toEqual([
      "apps/api/old.ts: previous renamed source could not be examined.",
    ]);
  });

  it("does not report a previous rename path from a non-applicable or non-affected owner", () => {
    const selection = select(snapshot({
      files: [file("apps/api/new.ts")],
      projects: [
        project("api", "apps/api", ["drizzle-orm", "postgres"]),
        project("web", "apps/web", ["drizzle-orm", "postgres"]),
      ],
      auditScope: changedScope(["api"], [{
        status: "renamed",
        path: "apps/api/new.ts",
        previousPath: "apps/web/old.ts",
      }]),
    }));

    expect(selection.files.map(({ path }) => path)).toEqual(["apps/api/new.ts"]);
    expect(selection.limitations).toEqual([]);
  });

  it("applies a validated deterministic file ceiling", () => {
    const value = snapshot({
      files: [file("z.ts"), file("a.ts"), file("m.ts")],
      projects: [project("root", ".", ["drizzle-orm", "postgres"])],
    });

    expect(select(value, { maxFiles: 2 })).toMatchObject({
      files: [file("a.ts"), file("m.ts")],
      limitations: ["Drizzle source selection stopped at the 2-file limit; 1 file was omitted."],
    });
    expect(() => select(value, { maxFiles: 0 })).toThrow(
      "maxFiles must be a positive safe integer.",
    );
  });

  it("retains the lexicographically earliest files and exactly counts a large overflow", () => {
    const files = Array.from({ length: 12_005 }, (_, index) =>
      file(`src/file-${String(12_004 - index).padStart(5, "0")}.ts`)
    );
    const selection = select(snapshot({
      files,
      projects: [project("root", ".", ["drizzle-orm", "postgres"])],
    }), { maxFiles: 3 });

    expect(selection.files.map(({ path }) => path)).toEqual([
      "src/file-00000.ts",
      "src/file-00001.ts",
      "src/file-00002.ts",
    ]);
    expect(selection.limitations).toEqual([
      "Drizzle source selection stopped at the 3-file limit; 12002 files were omitted.",
    ]);
  });

  it("bounds and deterministically sorts limitations", () => {
    const changes = ["z.md", "b.md", "a.md"].map((path) => ({
      status: "modified" as const,
      path,
    }));
    const selection = select(snapshot({
      projects: [project("root", ".", ["drizzle-orm", "postgres"])],
      auditScope: changedScope(["root"], changes),
    }), { maxLimitations: 2 });

    expect(selection.limitations).toEqual([
      "a.md: changed path is not an inventoried regular file.",
      "Drizzle source selection omitted 2 additional limitations.",
    ]);
    expect(select(snapshot({
      projects: [project("root", ".", ["drizzle-orm", "postgres"])],
      auditScope: changedScope(["root"], changes),
    }), { maxLimitations: 1 }).limitations).toEqual([
      "Drizzle source selection omitted 3 additional limitations.",
    ]);
  });
});
