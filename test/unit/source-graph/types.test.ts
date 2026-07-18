import { describe, expect, it } from "vitest";
import type {
  MissingTargetProof,
  SourceGraph,
  SourceGraphEdge,
  SourceImpact,
} from "../../../src/source-graph/types.js";

describe("source graph contracts", () => {
  it("represent topology and impact with safe paths and fixed classifications", () => {
    const proof: MissingTargetProof = "relative-explicit";
    const edge: SourceGraphEdge = {
      importerPath: "src/routes.ts",
      targetPath: "src/auth/session.ts",
      kind: "static",
      targetExists: false,
      missingTargetProof: proof,
      line: 4,
      column: 1,
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
    expect(edge.missingTargetProof).toBe("relative-explicit");
    expect(edge).toMatchObject({ line: 4, column: 1 });
    expect(impact.impacts[0]?.dependencyPath).toEqual([
      "src/auth/session.ts",
      "src/routes.ts",
    ]);
  });
});
