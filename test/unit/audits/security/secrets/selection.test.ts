import { describe, expect, it } from "vitest";
import { selectSecretAuditFiles } from "../../../../../src/audits/security/secrets/selection.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";

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

function files(...paths: string[]): ProjectSnapshot["files"] {
  return paths.map((path) => ({ path, kind: "file" as const, size: 10 }));
}

describe("secret audit file selection", () => {
  it("uses the Git shareable set so tracked env files remain selected", () => {
    const selection = selectSecretAuditFiles(snapshot({
      files: files(".env", ".env.local", ".env.example", "src/config.ts", "notes.txt"),
      repositoryFiles: {
        availability: "available",
        paths: [".env", ".env.example", "src/config.ts"],
        limitations: [],
      },
    }));

    expect(selection).toEqual({
      scope: "full",
      files: files(".env", ".env.example", "src/config.ts"),
      limitations: [],
    });
  });

  it("excludes local env variants but keeps templates when Git is unavailable", () => {
    const limitation = "Git shareable-file selection was unavailable.";
    const selection = selectSecretAuditFiles(snapshot({
      files: files(
        ".env",
        ".env.local",
        "config/.env.production",
        ".env.example",
        ".env.sample",
        ".env.template",
        "src/config.ts",
      ),
      repositoryFiles: {
        availability: "unavailable",
        paths: [],
        limitations: [limitation],
      },
    }));

    expect(selection.files.map(({ path }) => path)).toEqual([
      ".env.example",
      ".env.sample",
      ".env.template",
      "src/config.ts",
    ]);
    expect(selection.limitations).toEqual([limitation]);
  });

  it("falls back with a safe limitation when selection metadata is absent", () => {
    const selection = selectSecretAuditFiles(snapshot({
      files: files(".env", "README.md"),
    }));

    expect(selection.files.map(({ path }) => path)).toEqual(["README.md"]);
    expect(selection.limitations).toEqual([
      "Git shareable-file selection was unavailable; conservative local-environment fallback rules were used.",
    ]);
  });

  it("selects current changed paths and reports deleted or missing paths", () => {
    const selection = selectSecretAuditFiles(snapshot({
      files: [
        ...files("added.ts", "copied.ts", "modified.ts", "renamed.ts", "untracked.ts"),
        { path: "linked.ts", kind: "symlink", size: 8 },
        { path: "unchanged.ts", kind: "file", size: 10 },
      ],
      auditScope: {
        mode: "changed",
        base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
        changes: [
          { status: "added", path: "added.ts" },
          { status: "copied", path: "copied.ts", previousPath: "source.ts" },
          { status: "deleted", path: "deleted.ts" },
          { status: "modified", path: "linked.ts" },
          { status: "modified", path: "missing.ts" },
          { status: "modified", path: "modified.ts" },
          { status: "renamed", path: "renamed.ts", previousPath: "old.ts" },
          { status: "untracked", path: "untracked.ts" },
        ],
        affectedProjectIds: [],
        reasons: [],
        limitations: [],
      },
    }));

    expect(selection.scope).toBe("changed");
    expect(selection.files.map(({ path }) => path)).toEqual([
      "added.ts",
      "copied.ts",
      "modified.ts",
      "renamed.ts",
      "untracked.ts",
    ]);
    expect(selection.limitations).toEqual([
      "deleted.ts: deleted changed path could not be examined for secrets.",
      "linked.ts: selected path is not an inventoried regular file.",
      "missing.ts: selected path is not an inventoried regular file.",
    ]);
  });

  it("returns an empty changed selection without calling it clean", () => {
    const selection = selectSecretAuditFiles(snapshot({
      files: files("unchanged.ts"),
      auditScope: {
        mode: "changed",
        base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
        changes: [],
        affectedProjectIds: [],
        reasons: [],
        limitations: [],
      },
    }));

    expect(selection).toEqual({ scope: "changed", files: [], limitations: [] });
  });
});
