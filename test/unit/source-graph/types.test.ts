import { describe, expect, it } from "vitest";
import type {
  SourceGraph,
  SourceGraphEdge,
  SourceImpact,
} from "../../../src/source-graph/types.js";

describe("source graph contracts", () => {
  it("represent topology and impact with safe paths and fixed classifications", () => {
    const edge: SourceGraphEdge = {
      importerPath: "src/routes.ts",
      targetPath: "src/auth/session.ts",
      kind: "static",
      targetExists: true,
    };
    const graph: SourceGraph = {
      status: "completed",
      nodes: [
        { path: "src/auth/session.ts", projectId: "root" },
        { path: "src/routes.ts", projectId: "root" },
      ],
      edges: [edge],
      filesExamined: 2,
      bytesExamined: 40,
      externalBoundaryCount: 1,
      dynamicBoundaryCount: 0,
      limitations: [],
    };
    const impact: SourceImpact = {
      mode: "changed",
      status: "completed",
      graphNodeCount: 2,
      graphEdgeCount: 1,
      externalBoundaryCount: 1,
      dynamicBoundaryCount: 0,
      changedSourcePaths: ["src/auth/session.ts"],
      impactedFileCount: 1,
      impactedProjectIds: ["root"],
      impacts: [{
        path: "src/routes.ts",
        projectId: "root",
        dependencyPath: ["src/auth/session.ts", "src/routes.ts"],
      }],
      omittedImpactCount: 0,
      limitations: [],
    };

    expect(JSON.stringify({ graph, impact })).not.toMatch(/specifier|sourceText|rawValue/);
    expect(impact.impacts[0]?.dependencyPath).toEqual([
      "src/auth/session.ts",
      "src/routes.ts",
    ]);
  });
});
