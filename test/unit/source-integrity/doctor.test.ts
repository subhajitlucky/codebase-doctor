import { describe, expect, it } from "vitest";
import { fullAuditScope } from "../../../src/scope/planner.js";
import { planSourceImpact } from "../../../src/source-graph/impact.js";
import type {
  SourceGraph,
  SourceGraphEdge,
} from "../../../src/source-graph/types.js";
import {
  createSourceIntegrityDoctor,
  sourceIntegrityDoctor,
} from "../../../src/source-integrity/doctor.js";
import type { ProjectSnapshot } from "../../../src/workspace/types.js";

function graph(
  edges: readonly SourceGraphEdge[],
  status: SourceGraph["status"] = "completed",
): SourceGraph {
  const paths = new Set(edges.map(({ importerPath }) => importerPath));
  return {
    status,
    nodes: [...paths].sort().map((path) => ({ path, projectId: "root" })),
    edges,
    filesExamined: paths.size,
    bytesExamined: paths.size * 20,
    externalBoundaryCount: 0,
    dynamicBoundaryCount: 0,
    limitations: status === "partial" ? ["Source graph is incomplete."] : [],
  };
}

function snapshot(
  sourceGraph?: SourceGraph,
  mode: "full" | "changed" = "full",
  changes: ProjectSnapshot["auditScope"]["changes"] = [],
): ProjectSnapshot {
  const auditScope = mode === "full"
    ? fullAuditScope()
    : {
        mode: "changed" as const,
        base: {
          kind: "head" as const,
          requestedRef: null,
          resolvedCommit: "a".repeat(40),
        },
        changes,
        affectedProjectIds: [],
        reasons: [],
        limitations: [],
      };
  return {
    root: "/repo",
    files: [],
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope,
    ...(sourceGraph === undefined
      ? {}
      : {
          sourceGraph,
          sourceImpact: planSourceImpact(mode, changes, sourceGraph),
        }),
  };
}

const missingEdges: readonly SourceGraphEdge[] = [
  {
    importerPath: "packages/a/src/index.ts",
    targetPath: "packages/shared/src/public.ts",
    kind: "static",
    line: 3,
    column: 9,
    targetExists: false,
  },
  {
    importerPath: "src/a.ts",
    targetPath: "src/missing.ts",
    kind: "re-export",
    line: 2,
    column: 1,
    targetExists: false,
    missingTargetProof: "relative-explicit",
  },
  {
    importerPath: "src/z.ts",
    targetPath: "src/lib/absent.ts",
    kind: "type-only",
    targetExists: false,
    missingTargetProof: "alias-explicit",
  },
];

describe("source integrity Doctor", () => {
  it("is a capability-free Doctor that requires a precomputed graph and impact", async () => {
    expect(sourceIntegrityDoctor.id).toBe("repository/source-integrity");
    expect(sourceIntegrityDoctor.version).toBe("0.1.0");
    expect(sourceIntegrityDoctor.capabilities).toEqual([]);
    expect(await sourceIntegrityDoctor.supports(snapshot(graph([])))).toBe(true);
    expect(await sourceIntegrityDoctor.supports(snapshot())).toBe(false);
  });

  it("reports every provably missing internal target in deterministic order", async () => {
    const result = await sourceIntegrityDoctor.diagnose({
      snapshot: snapshot(graph(missingEdges, "partial")),
      allowedCapabilities: new Set(),
    });

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map(({ location }) => location?.path)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(result.findings[0]).toMatchObject({
      ruleId: "source/import-target-missing",
      doctorId: "repository/source-integrity",
      severity: "high",
      confidence: "high",
      category: "correctness",
      title: "Internal import target is missing",
      location: { path: "src/a.ts", line: 2, column: 1 },
      verification: {
        command: "codebase-doctor scan --format json",
      },
    });
    expect(result.findings[0]?.evidence).toEqual([{
      type: "file",
      path: "src/a.ts",
      detail:
        "Expected internal target src/missing.ts (re-export; proof: relative-explicit), but it is absent from the bounded repository inventory.",
    }]);
    expect(result.findings[0]?.remediation).toContain("Codebase Doctor does not modify files");
    expect(new Set(result.findings.map(({ fingerprint }) => fingerprint)).size).toBe(2);
    expect(result.coverage).toEqual([{
      moduleId: "repository/source-integrity",
      status: "partial",
      scope: "full",
      filesExamined: 3,
      statementsExamined: 3,
      statementsRecognized: 2,
      limitations: ["Source graph is incomplete."],
    }]);
  });

  it("ignores existing, unproven, malformed, and cyclic references", async () => {
    const unsafeEdge = {
      importerPath: "src/existing.ts",
      targetPath: "src/a.ts",
      kind: "static",
      targetExists: true,
      missingTargetProof: "relative-explicit",
      rawSpecifier: "secret-value-must-not-appear",
    } as unknown as SourceGraphEdge;
    const sourceGraph = graph([
      unsafeEdge,
      {
        importerPath: "src/a.ts",
        targetPath: "src/b.ts",
        kind: "static",
        targetExists: true,
      },
      {
        importerPath: "src/b.ts",
        targetPath: "src/a.ts",
        kind: "static",
        targetExists: true,
      },
      {
        importerPath: "src/unproven.ts",
        targetPath: "src/maybe.ts",
        kind: "static",
        targetExists: false,
      },
    ]);

    const result = await sourceIntegrityDoctor.diagnose({
      snapshot: snapshot(sourceGraph),
      allowedCapabilities: new Set(),
    });

    expect(result.findings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret-value-must-not-appear");
    expect(result.coverage?.[0]).toMatchObject({
      status: "completed",
      statementsExamined: 4,
      statementsRecognized: 0,
    });
  });

  it("limits changed scans to changed and complete reverse-impacted importers", async () => {
    const sourceGraph = graph([
      {
        importerPath: "src/direct.ts",
        targetPath: "src/direct-missing.ts",
        kind: "static",
        targetExists: false,
        missingTargetProof: "relative-explicit",
      },
      {
        importerPath: "src/consumer.ts",
        targetPath: "src/changed.ts",
        kind: "static",
        targetExists: true,
      },
      {
        importerPath: "src/consumer.ts",
        targetPath: "src/consumer-missing.ts",
        kind: "static",
        targetExists: false,
        missingTargetProof: "relative-explicit",
      },
      {
        importerPath: "src/unrelated.ts",
        targetPath: "src/unrelated-missing.ts",
        kind: "static",
        targetExists: false,
        missingTargetProof: "relative-explicit",
      },
    ]);
    const changes = [
      { status: "modified" as const, path: "src/direct.ts" },
      { status: "modified" as const, path: "src/changed.ts" },
    ];

    const result = await sourceIntegrityDoctor.diagnose({
      snapshot: snapshot(sourceGraph, "changed", changes),
      allowedCapabilities: new Set(),
    });

    expect(result.findings.map(({ location }) => location?.path)).toEqual([
      "src/consumer.ts",
      "src/direct.ts",
    ]);
    expect(result.coverage?.[0]).toMatchObject({
      status: "completed",
      scope: "changed",
      filesExamined: 2,
      statementsExamined: 3,
      statementsRecognized: 2,
    });
  });

  it("selects an importer when its explicit target was deleted or renamed", async () => {
    const sourceGraph = graph([{
      importerPath: "src/importer.ts",
      targetPath: "src/old-target.ts",
      kind: "static",
      targetExists: false,
      missingTargetProof: "relative-explicit",
    }]);
    const changes = [{
      status: "renamed" as const,
      previousPath: "src/old-target.ts",
      path: "src/new-target.ts",
    }];

    const result = await sourceIntegrityDoctor.diagnose({
      snapshot: snapshot(sourceGraph, "changed", changes),
      allowedCapabilities: new Set(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location?.path).toBe("src/importer.ts");
  });

  it("caps findings and marks coverage partial", async () => {
    expect(() => createSourceIntegrityDoctor({ maxFindings: 0 })).toThrow(
      "maxFindings must be a positive safe integer.",
    );
    const doctor = createSourceIntegrityDoctor({ maxFindings: 1 });
    const result = await doctor.diagnose({
      snapshot: snapshot(graph(missingEdges)),
      allowedCapabilities: new Set(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.coverage?.[0]?.status).toBe("partial");
    expect(result.coverage?.[0]?.limitations).toContain(
      "Source integrity findings were limited to 1 of 2 provably missing targets.",
    );
  });

  it.each(["not-applicable", "not-selected"] as const)(
    "preserves %s coverage without findings",
    async (status) => {
      const sourceGraph = graph([]);
      const baseSnapshot = snapshot(sourceGraph);
      const result = await sourceIntegrityDoctor.diagnose({
        snapshot: {
          ...baseSnapshot,
          sourceImpact: { ...baseSnapshot.sourceImpact!, status },
        },
        allowedCapabilities: new Set(),
      });

      expect(result.findings).toEqual([]);
      expect(result.coverage?.[0]?.status).toBe(status);
    },
  );
});
