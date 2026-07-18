import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_IMPACT_VISITS,
  DEFAULT_MAX_REPORTED_IMPACTS,
  impactedSourcePaths,
  planSourceImpact,
} from "../../../src/source-graph/impact.js";
import type { ChangedPath } from "../../../src/scope/types.js";
import type { SourceGraph, SourceGraphEdge } from "../../../src/source-graph/types.js";

function graph(
  paths: readonly (string | readonly [string, string])[],
  edges: readonly SourceGraphEdge[],
  status: SourceGraph["status"] = "completed",
): SourceGraph {
  return {
    status,
    nodes: paths.map((entry) => Array.isArray(entry)
      ? { path: entry[0]!, projectId: entry[1]! }
      : { path: entry as string }),
    edges,
    filesExamined: paths.length,
    bytesExamined: 100,
    externalBoundaryCount: 2,
    dynamicBoundaryCount: 1,
    limitations: status === "partial" ? ["graph limitation"] : [],
  };
}

function edge(importerPath: string, targetPath: string): SourceGraphEdge {
  return { importerPath, targetPath, kind: "static", targetExists: true };
}

function change(status: ChangedPath["status"], path: string, previousPath?: string): ChangedPath {
  return { status, path, ...(previousPath === undefined ? {} : { previousPath }) };
}

describe("source impact planning", () => {
  it("reports only graph counts and coverage for full mode", () => {
    const result = planSourceImpact("full", [], graph(
      ["src/a.ts", "src/b.ts"],
      [edge("src/b.ts", "src/a.ts")],
    ));

    expect(result).toEqual({
      mode: "full",
      status: "completed",
      graphNodeCount: 2,
      graphEdgeCount: 1,
      externalBoundaryCount: 2,
      dynamicBoundaryCount: 1,
      changedSourcePaths: [],
      impactedFileCount: 0,
      impactedProjectIds: [],
      impacts: [],
      omittedImpactCount: 0,
      limitations: [],
    });
  });

  it("walks reverse dependencies and records deterministic shortest paths", () => {
    const result = planSourceImpact("changed", [change("modified", "src/a.ts")], graph(
      [
        ["src/a.ts", "core"],
        ["src/b.ts", "api"],
        ["src/c.ts", "web"],
      ],
      [edge("src/c.ts", "src/b.ts"), edge("src/b.ts", "src/a.ts")],
    ));

    expect(result.changedSourcePaths).toEqual(["src/a.ts"]);
    expect(result.impactedFileCount).toBe(2);
    expect(result.impactedProjectIds).toEqual(["api", "web"]);
    expect(result.impacts).toEqual([
      {
        path: "src/b.ts",
        projectId: "api",
        dependencyPath: ["src/a.ts", "src/b.ts"],
      },
      {
        path: "src/c.ts",
        projectId: "web",
        dependencyPath: ["src/a.ts", "src/b.ts", "src/c.ts"],
      },
    ]);
  });

  it("uses lexical tie-breaking when several shortest explanations exist", () => {
    const result = planSourceImpact("changed", [
      change("modified", "src/z.ts"),
      change("modified", "src/a.ts"),
    ], graph(
      ["src/a.ts", "src/z.ts", "src/consumer.ts"],
      [edge("src/consumer.ts", "src/z.ts"), edge("src/consumer.ts", "src/a.ts")],
    ));

    expect(result.impacts).toEqual([{
      path: "src/consumer.ts",
      dependencyPath: ["src/a.ts", "src/consumer.ts"],
    }]);
  });

  it("terminates cycles without reporting changed roots as their own impact", () => {
    const result = planSourceImpact("changed", [change("modified", "src/a.ts")], graph(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      [
        edge("src/b.ts", "src/a.ts"),
        edge("src/c.ts", "src/b.ts"),
        edge("src/a.ts", "src/c.ts"),
      ],
    ));

    expect(result.impacts.map(({ path }) => path)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("seeds deleted paths and both sides of renames but not copy sources", () => {
    const result = planSourceImpact("changed", [
      change("deleted", "src/deleted.ts"),
      change("renamed", "src/new.ts", "src/old.ts"),
      change("copied", "src/copy.ts", "src/original.ts"),
    ], graph(
      ["src/deleted-consumer.ts", "src/old-consumer.ts", "src/new-consumer.ts", "src/original-consumer.ts"],
      [
        edge("src/deleted-consumer.ts", "src/deleted.ts"),
        edge("src/old-consumer.ts", "src/old.ts"),
        edge("src/new-consumer.ts", "src/new.ts"),
        edge("src/original-consumer.ts", "src/original.ts"),
      ],
    ));

    expect(result.changedSourcePaths).toEqual([
      "src/copy.ts",
      "src/deleted.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(result.impacts.map(({ path }) => path)).toEqual([
      "src/deleted-consumer.ts",
      "src/new-consumer.ts",
      "src/old-consumer.ts",
    ]);
  });

  it("keeps every discovered project when report records are truncated", () => {
    const result = planSourceImpact("changed", [change("modified", "src/root.ts")], graph(
      [
        ["src/root.ts", "root"],
        ["packages/a.ts", "a"],
        ["packages/b.ts", "b"],
        ["packages/c.ts", "c"],
      ],
      [
        edge("packages/a.ts", "src/root.ts"),
        edge("packages/b.ts", "src/root.ts"),
        edge("packages/c.ts", "src/root.ts"),
      ],
    ), { maxReportedImpacts: 1 });

    expect(DEFAULT_MAX_REPORTED_IMPACTS).toBe(1_000);
    expect(result.impactedFileCount).toBe(3);
    expect(result.impactedProjectIds).toEqual(["a", "b", "c"]);
    expect(result.impacts).toHaveLength(1);
    expect(result.omittedImpactCount).toBe(2);
    expect([...impactedSourcePaths(result)]).toEqual([
      "packages/a.ts",
      "packages/b.ts",
      "packages/c.ts",
    ]);
  });

  it("keeps private impact paths off full and unrecognized report objects", () => {
    const full = planSourceImpact("full", [], graph(
      ["src/a.ts", "src/b.ts"],
      [edge("src/b.ts", "src/a.ts")],
    ));
    const changed = planSourceImpact("changed", [change("modified", "src/a.ts")], graph(
      ["src/a.ts", "src/b.ts"],
      [edge("src/b.ts", "src/a.ts")],
    ));
    const copied = { ...changed, impacts: [...changed.impacts] };

    expect([...impactedSourcePaths(full)]).toEqual([]);
    expect([...impactedSourcePaths(copied)]).toEqual([]);
    expect(JSON.stringify(changed)).not.toContain("impactedSourcePaths");
  });

  it("marks traversal ceilings partial without fabricating remaining impact", () => {
    const result = planSourceImpact("changed", [change("modified", "src/a.ts")], graph(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      [edge("src/b.ts", "src/a.ts"), edge("src/c.ts", "src/b.ts")],
    ), { maxVisitedFiles: 1 });

    expect(DEFAULT_MAX_IMPACT_VISITS).toBe(100_000);
    expect(result.status).toBe("partial");
    expect(result.impactedFileCount).toBe(1);
    expect(result.limitations).toContain(
      "Source impact stopped at the 1-file traversal limit.",
    );
  });

  it("preserves graph limitations and reports unrelated changed scope as not selected", () => {
    const unrelated = planSourceImpact("changed", [
      change("modified", "README.md"),
    ], graph(["src/a.ts"], []));
    const partial = planSourceImpact("changed", [], graph(["src/a.ts"], [], "partial"));

    expect(unrelated.status).toBe("not-selected");
    expect(unrelated.changedSourcePaths).toEqual([]);
    expect(partial.status).toBe("partial");
    expect(partial.limitations).toEqual(["graph limitation"]);
  });

  it("rejects invalid impact ceilings", () => {
    const sourceGraph = graph([], []);
    expect(() => planSourceImpact("changed", [], sourceGraph, { maxReportedImpacts: 0 }))
      .toThrow(/positive safe integer/i);
    expect(() => planSourceImpact("changed", [], sourceGraph, { maxVisitedFiles: -1 }))
      .toThrow(/positive safe integer/i);
  });
});
