import { describe, expect, it } from "vitest";
import { createPerformanceDoctor } from "../../../../src/audits/performance/static/doctor.js";
import type { AuditCoverage } from "../../../../src/core/doctor.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { AuditScope, ChangedPath } from "../../../../src/scope/types.js";
import type { FileRecord, ProjectSnapshot } from "../../../../src/workspace/types.js";

function file(path: string, size: number): FileRecord {
  return { path, kind: "file", size };
}

function snapshotWith(
  files: FileRecord[],
  auditScope: AuditScope = fullAuditScope(),
  repositoryFiles?: ProjectSnapshot["repositoryFiles"],
): ProjectSnapshot {
  return {
    root: "/repo",
    files,
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope,
    ...(repositoryFiles === undefined ? {} : { repositoryFiles }),
  };
}

function changedScope(changes: readonly ChangedPath[]): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes,
    affectedProjectIds: [],
    reasons: [],
    limitations: [],
  };
}

function shareable(paths: string[]): ProjectSnapshot["repositoryFiles"] {
  return { availability: "available", paths, limitations: [] };
}

const FILES: FileRecord[] = [
  file("src/app.ts", 1_024),
  file("vendor/app.bundle.js", 900_000),
  file("src/big-generated.ts", 600_000),
  file("package-lock.json", 2_000_000),
  file("assets/logo.png", 3_000_000),
  file("src/app.js.map", 50_000),
];

describe("performance/static doctor", () => {
  it("flags build artifacts and large sources but not lockfiles or binary assets", async () => {
    const doctor = createPerformanceDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(FILES, fullAuditScope(), shareable(FILES.map(({ path }) => path))),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    const rules = result.findings.map(({ ruleId }) => ruleId);
    expect(rules).toContain("performance/static/committed-build-artifact");
    expect(rules).toContain("performance/static/large-file");
    const paths = result.findings.map((finding) => finding.location?.path);
    expect(paths).toContain("vendor/app.bundle.js");
    expect(paths).toContain("src/app.js.map");
    expect(paths).toContain("src/big-generated.ts");
    expect(paths).not.toContain("package-lock.json");
    expect(paths).not.toContain("assets/logo.png");
    expect(paths).not.toContain("src/app.ts");
    for (const finding of result.findings) {
      expect(finding.severity).toBe("low");
      expect(finding.confidence).toBe("high");
    }

    const moduleCoverage = result.coverage?.find(
      (entry: AuditCoverage) => entry.moduleId === "performance/static",
    );
    expect(moduleCoverage).toMatchObject({ status: "completed", scope: "full" });
  });

  it("excludes ignored local build output through shareable-file selection", async () => {
    const doctor = createPerformanceDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(
        [...FILES, file("local-output.mcpb", 5_000_000)],
        fullAuditScope(),
        shareable(FILES.map(({ path }) => path)),
      ),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings.map((finding) => finding.location?.path)).not.toContain(
      "local-output.mcpb",
    );
  });

  it("warns honestly when shareable-file selection is unavailable", async () => {
    const doctor = createPerformanceDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith([file("vendor/app.bundle.js", 900_000)]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toHaveLength(1);
    const moduleCoverage = result.coverage?.find(
      (entry: AuditCoverage) => entry.moduleId === "performance/static",
    );
    expect(moduleCoverage?.limitations.join(" ")).toContain("shareable-file selection was unavailable");
  });

  it("examines only changed inventoried paths in changed mode", async () => {
    const doctor = createPerformanceDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(
        FILES,
        changedScope([
          { status: "modified", path: "src/big-generated.ts" },
          { status: "deleted", path: "vendor/app.bundle.js" },
          { status: "modified", path: "src/app.ts" },
        ]),
      ),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings.map((finding) => finding.location?.path)).toEqual([
      "src/big-generated.ts",
    ]);
    const moduleCoverage = result.coverage?.find(
      (entry: AuditCoverage) => entry.moduleId === "performance/static",
    );
    expect(moduleCoverage).toMatchObject({ status: "partial", scope: "changed" });
    expect(moduleCoverage?.limitations.join(" ")).toContain("deleted changed path");
  });

  it("reports not-applicable when nothing qualifies", async () => {
    const doctor = createPerformanceDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith([], fullAuditScope(), shareable([])),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toEqual([]);
    expect(result.coverage?.[0]).toMatchObject({
      moduleId: "performance/static",
      status: "not-applicable",
    });
  });

  it("bounds findings and reports partial coverage at the cap", async () => {
    const doctor = createPerformanceDoctor({ maxFindings: 1 });
    const result = await doctor.diagnose({
      snapshot: snapshotWith(FILES, fullAuditScope(), shareable(FILES.map(({ path }) => path))),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toHaveLength(1);
    const moduleCoverage = result.coverage?.find(
      (entry: AuditCoverage) => entry.moduleId === "performance/static",
    );
    expect(moduleCoverage?.status).toBe("partial");
    expect(moduleCoverage?.limitations.join(" ")).toContain("finding limit of 1 was reached");
  });
});
