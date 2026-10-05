import { describe, expect, it } from "vitest";
import {
  getChangedLines,
  parseUnifiedDiffZeroContext,
} from "../../../src/review/changed-lines.js";

describe("parseUnifiedDiffZeroContext", () => {
  it("collects added lines per new path across hunks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@ context",
      " context",
      "-removed",
      "+added one",
      "+added two",
      "@@ -10 +12 @@ single",
      "+another",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -5,0 +6,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiffZeroContext(diff);

    expect(parsed.get("src/a.ts")).toEqual(new Set([1, 2, 3, 12]));
    expect(parsed.get("src/b.ts")).toEqual(new Set([6, 7]));
  });

  it("ignores deleted files and records added files", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiffZeroContext(diff);

    expect(parsed.has("gone.ts")).toBe(false);
    expect(parsed.get("new.ts")).toEqual(new Set([1, 2]));
  });

  it("resolves renames to the new path", () => {
    const diff = [
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to renamed.ts",
      "--- a/old.ts",
      "+++ b/renamed.ts",
      "@@ -1 +1,2 @@",
      " context",
      "+inserted",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiffZeroContext(diff);

    expect(parsed.get("renamed.ts")).toEqual(new Set([1, 2]));
    expect(parsed.has("old.ts")).toBe(false);
  });

  it("returns an empty map for empty diff output", () => {
    expect(parseUnifiedDiffZeroContext("")).toEqual(new Map());
  });
});

describe("getChangedLines", () => {
  it("marks untracked files as all-lines and keeps parsed hunks", async () => {
    const diff = [
      "diff --git a/tracked.ts b/tracked.ts",
      "--- a/tracked.ts",
      "+++ b/tracked.ts",
      "@@ -1 +1,2 @@",
      " context",
      "+inserted",
      "",
    ].join("\n");
    const runner = {
      async run(_root: string, _args: readonly string[]): Promise<string> {
        return diff;
      },
    };

    const changed = await getChangedLines(
      {
        root: "/repo",
        baseCommit: "abc123",
        changes: [
          { status: "modified" as const, path: "tracked.ts" },
          { status: "untracked" as const, path: "fresh.ts" },
        ],
      },
      runner,
    );

    expect(changed.get("tracked.ts")).toEqual(new Set([1, 2]));
    expect(changed.get("fresh.ts")).toBe("all");
  });

  it("propagates git failures so callers can fall back to file-level filtering", async () => {
    const runner = {
      async run(): Promise<string> {
        throw new Error("git exploded");
      },
    };

    await expect(getChangedLines({
      root: "/repo",
      baseCommit: "abc123",
      changes: [],
    }, runner)).rejects.toThrow("git exploded");
  });
});
