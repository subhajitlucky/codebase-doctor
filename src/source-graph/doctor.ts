import type { Doctor } from "../core/doctor.js";

export const sourceGraphDoctor: Doctor = {
  id: "repository/source-graph",
  version: "0.1.0",
  capabilities: [],
  supports: (snapshot) =>
    snapshot.sourceGraph !== undefined && snapshot.sourceImpact !== undefined,
  diagnose: async ({ snapshot }) => {
    const graph = snapshot.sourceGraph;
    const impact = snapshot.sourceImpact;
    if (graph === undefined || impact === undefined) {
      throw new Error("Precomputed source graph impact is unavailable.");
    }
    return {
      status: "completed",
      findings: [],
      durationMs: 0,
      coverage: [{
        moduleId: "repository/source-graph",
        status: impact.status,
        scope: impact.mode,
        filesExamined: graph.filesExamined,
        statementsExamined:
          graph.edges.length + graph.externalBoundaryCount + graph.dynamicBoundaryCount,
        statementsRecognized: graph.edges.length,
        limitations: [...impact.limitations],
      }],
    };
  },
};
