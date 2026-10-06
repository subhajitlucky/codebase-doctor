import { describe, expect, it } from "vitest";
import { selectChangedCandidates } from "../../../src/scope/changed-files.js";
import type { ChangedPath } from "../../../src/scope/types.js";
import type { FileRecord } from "../../../src/workspace/types.js";

const files: FileRecord[] = [
  { path: "src/a.ts", kind: "file", size: 10 },
  { path: "src/b.ts", kind: "file", size: 10 },
  { path: "docs/c.md", kind: "file", size: 10 },
];

const changes: ChangedPath[] = [
  { status: "modified", path: "src/a.ts" },
  { status: "deleted", path: "src/gone.ts" },
  { status: "modified", path: "src/missing.ts" },
  { status: "untracked", path: "docs/c.md" },
  { status: "modified", path: "README.md" },
];

const isTs = (path: string): boolean => path.endsWith(".ts");

describe("selectChangedCandidates", () => {
  it("keeps inventoried changed paths and limits every other case", () => {
    const selection = selectChangedCandidates(changes, files, isTs, "backend auth");

    expect(selection.candidates).toEqual(["src/a.ts"]);
    expect(selection.limitations).toEqual([
      "src/gone.ts: deleted changed path could not be examined for backend auth.",
      "src/missing.ts: changed path is not an inventoried regular file for backend auth.",
    ]);
  });

  it("ignores changes no doctor would examine", () => {
    const selection = selectChangedCandidates(changes, files, () => false, "backend auth");

    expect(selection.candidates).toEqual([]);
    expect(selection.limitations).toEqual([]);
  });
});
