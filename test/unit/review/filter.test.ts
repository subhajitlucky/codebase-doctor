import { describe, expect, it } from "vitest";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import type { ChangedPath } from "../../../src/scope/types.js";
import type { ChangedLines, ChangedLineSet } from "../../../src/review/changed-lines.js";
import { filterFindingsToDiff } from "../../../src/review/filter.js";

function finding(
  ruleId: string,
  severity: Severity = "high",
  location?: { path: string; line?: number; column?: number },
): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: `${ruleId} title`,
    message: `${ruleId} message`,
    ...(location === undefined ? {} : { location }),
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId,
      ...(location === undefined ? {} : { location }),
      identity: ruleId,
    }),
  };
}

const changes: ChangedPath[] = [
  { status: "modified", path: "src/changed.ts" },
  { status: "untracked", path: "src/fresh.ts" },
  { status: "deleted", path: "src/gone.ts" },
];

const changedLines: ChangedLines = new Map<string, ChangedLineSet>([
  ["src/changed.ts", new Set([10, 11])],
  ["src/fresh.ts", "all"],
]);

describe("filterFindingsToDiff", () => {
  it("keeps added-line findings and global findings, drops the rest", () => {
    const findings = [
      finding("on-added-line", "high", { path: "src/changed.ts", line: 10 }),
      finding("on-removed-line", "high", { path: "src/changed.ts", line: 3 }),
      finding("file-level", "medium", { path: "src/changed.ts" }),
      finding("untracked-any-line", "high", { path: "src/fresh.ts", line: 99 }),
      finding("unchanged-file", "high", { path: "src/other.ts", line: 1 }),
      finding("deleted-file-line", "high", { path: "src/gone.ts", line: 1 }),
      finding("deleted-file-level", "high", { path: "src/gone.ts" }),
      finding("global", "low"),
    ];

    const filtered = filterFindingsToDiff(findings, changes, changedLines);

    expect(filtered.linePrecision).toBe(true);
    expect(filtered.included.map(({ ruleId }) => ruleId).sort()).toEqual(
      ["deleted-file-level", "file-level", "global", "on-added-line", "untracked-any-line"].sort(),
    );
    expect(filtered.excluded.map(({ ruleId }) => ruleId).sort()).toEqual(
      ["deleted-file-line", "on-removed-line", "unchanged-file"].sort(),
    );
  });

  it("treats deletion-only changed paths as unprovable for line findings", () => {
    const filtered = filterFindingsToDiff(
      [finding("line-in-deletion-only", "high", { path: "src/changed.ts", line: 50 })],
      changes,
      new Map(),
    );

    expect(filtered.included).toEqual([]);
    expect(filtered.excluded).toHaveLength(1);
  });

  it("falls back to file-level matching without a line index", () => {
    const filtered = filterFindingsToDiff(
      [
        finding("any-line", "high", { path: "src/changed.ts", line: 77 }),
        finding("elsewhere", "high", { path: "src/other.ts", line: 1 }),
      ],
      changes,
      undefined,
    );

    expect(filtered.linePrecision).toBe(false);
    expect(filtered.included.map(({ ruleId }) => ruleId)).toEqual(["any-line"]);
    expect(filtered.excluded.map(({ ruleId }) => ruleId)).toEqual(["elsewhere"]);
  });

  it("keeps everything with --all-findings", () => {
    const findings = [
      finding("inside", "high", { path: "src/changed.ts", line: 10 }),
      finding("outside", "high", { path: "src/other.ts", line: 1 }),
    ];

    const filtered = filterFindingsToDiff(findings, changes, changedLines, {
      allFindings: true,
    });

    expect(filtered.included).toHaveLength(2);
    expect(filtered.excluded).toEqual([]);
  });
});
