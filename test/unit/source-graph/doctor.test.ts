import { describe, expect, it } from "vitest";
import { sourceGraphDoctor } from "../../../src/source-graph/doctor.js";
import { fullAuditScope } from "../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../src/workspace/types.js";
import type { SourceGraph, SourceImpact } from "../../../src/source-graph/types.js";

const graph: SourceGraph = {
  status: "partial",
  nodes: [{ path: "src/a.ts", projectId: "root" }],
  edges: [{
    importerPath: "src/a.ts",
    targetPath: "src/missing.ts",
    kind: "static",
    targetExists: false,
  }],
  filesExamined: 1,
  bytesExamined: 20,
  externalBoundaryCount: 2,
  dynamicBoundaryCount: 1,
  limitations: ["src/a.ts: relative source target was not found in the current inventory."],
};

function impact(status: SourceImpact["status"]): SourceImpact {
  return {
    mode: "changed",
    status,
    graphNodeCount: 1,
    graphEdgeCount: 1,
    externalBoundaryCount: 2,
    dynamicBoundaryCount: 1,
    changedSourcePaths: ["src/a.ts"],
    impactedFileCount: 0,
    impactedProjectIds: [],
    impacts: [],
    omittedImpactCount: 0,
    limitations: [...graph.limitations],
  };
}

function snapshot(sourceImpact?: SourceImpact): ProjectSnapshot {
  return {
    root: "/repo",
    files: [],
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
    sourceGraph: graph,
    ...(sourceImpact === undefined ? {} : { sourceImpact }),
  };
}

describe("source graph Doctor", () => {
  it("is finding-free and requires no process, network, or write capability", async () => {
    expect(sourceGraphDoctor.id).toBe("repository/source-graph");
    expect(sourceGraphDoctor.capabilities).toEqual([]);
    expect(await sourceGraphDoctor.supports(snapshot(impact("partial")))).toBe(true);

    const result = await sourceGraphDoctor.diagnose({
      snapshot: snapshot(impact("partial")),
      allowedCapabilities: new Set(),
    });

    expect(result.status).toBe("completed");
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([{
      moduleId: "repository/source-graph",
      status: "partial",
      scope: "changed",
      filesExamined: 1,
      statementsExamined: 4,
      statementsRecognized: 1,
      limitations: graph.limitations,
    }]);
  });

  it.each(["completed", "partial", "not-selected", "not-applicable"] as const)(
    "maps %s impact coverage without producing a finding",
    async (status) => {
      const result = await sourceGraphDoctor.diagnose({
        snapshot: snapshot(impact(status)),
        allowedCapabilities: new Set(),
      });

      expect(result.findings).toEqual([]);
      expect(result.coverage?.[0]?.status).toBe(status);
    },
  );

  it("does not claim support when precomputed impact is unavailable", async () => {
    expect(await sourceGraphDoctor.supports(snapshot())).toBe(false);
  });
});
