import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createDependenciesDoctor } from "../../../../../src/audits/security/dependencies/doctor.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../../src/scope/types.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";

function changedScope(affectedProjectIds: readonly string[] = []): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes: [],
    affectedProjectIds,
    reasons: [],
    limitations: [],
  };
}

function npmSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/repo",
    files: [
      { path: "package.json", kind: "file", size: 100 },
      { path: "package-lock.json", kind: "file", size: 500 },
    ],
    manifests: [{
      kind: "package-json",
      path: "package.json",
      status: "valid",
      data: { dependencies: { alpha: "^1.0.0" } },
    }],
    projects: [{
      id: "root",
      root: ".",
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: [],
      packageManager: "npm",
      packageName: "fixture",
      dependencyNames: ["alpha"],
      manifestPaths: ["package.json"],
      executionSupport: "supported",
    }],
    workspaces: [],
    auditScope: fullAuditScope(),
    ...overrides,
  };
}

function lock(packages: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ lockfileVersion: 3, packages }));
}

describe("Dependencies Doctor", () => {
  it("is an offline read-only built-in Doctor", async () => {
    const doctor = createDependenciesDoctor({ readFile: async () => lock({ "": {} }) });

    expect(doctor).toMatchObject({
      id: "security/dependencies",
      version: "0.1.0",
      capabilities: ["filesystem:read"],
    });
    expect(await doctor.supports(npmSnapshot())).toBe(true);
  });

  it("returns deterministic safe findings with completed coverage", async () => {
    const seed = ["doctor", "-source-", "credential-5Hs"].join("");
    const spec = `http://user:${seed}@example.invalid/alpha.tgz?token=${seed}`;
    const readFile = vi.fn(async () => lock({ "": { dependencies: { alpha: spec } } }));
    const doctor = createDependenciesDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: npmSnapshot({
        manifests: [{
          kind: "package-json",
          path: "package.json",
          status: "valid",
          data: { dependencies: { alpha: spec } },
        }],
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).toHaveBeenCalledWith("/repo/package-lock.json");
    expect(result.status).toBe("completed");
    expect(result.coverage).toEqual([expect.objectContaining({
      moduleId: "security/dependencies",
      status: "completed",
      scope: "full:.",
      filesExamined: 2,
      statementsRecognized: 1,
      limitations: [],
    })]);
    expect(result.findings).toEqual([expect.objectContaining({
      ruleId: "security/dependencies/insecure-source",
      doctorId: "security/dependencies",
      severity: "high",
      confidence: "high",
      category: "security",
      location: { path: "package.json" },
      evidence: [expect.objectContaining({
        type: "manifest",
        path: "package.json",
      })],
    })]);
    expect(result.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(seed);
  });

  it("reports dependency-free repositories as not applicable", async () => {
    const readFile = vi.fn(async () => lock({}));
    const doctor = createDependenciesDoctor({ readFile });
    const { packageManager: _packageManager, ...dependencyFreeProject } =
      npmSnapshot().projects[0]!;
    const result = await doctor.diagnose({
      snapshot: npmSnapshot({
        files: [{ path: "package.json", kind: "file", size: 10 }],
        manifests: [{
          kind: "package-json",
          path: "package.json",
          status: "valid",
          data: {},
        }],
        projects: [{
          ...dependencyFreeProject,
          dependencyNames: [],
        }],
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "not-applicable",
      scope: "full:root",
    })]);
  });

  it("reports unsupported package-manager coverage without fabricated findings", async () => {
    const doctor = createDependenciesDoctor({ readFile: async () => lock({}) });
    const result = await doctor.diagnose({
      snapshot: npmSnapshot({
        projects: [{
          ...npmSnapshot().projects[0]!,
          packageManager: "pnpm",
        }],
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([{
      moduleId: "security/dependencies",
      status: "unsupported",
      scope: "full:root",
      filesExamined: 0,
      statementsExamined: 0,
      statementsRecognized: 0,
      limitations: ["root: node:pnpm dependency metadata is not supported."],
    }]);
  });

  it("preserves an unrelated changed scope as not selected", async () => {
    const readFile = vi.fn(async () => lock({}));
    const doctor = createDependenciesDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: npmSnapshot({ auditScope: changedScope() }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([{
      moduleId: "security/dependencies",
      status: "not-selected",
      scope: "changed",
      filesExamined: 0,
      statementsExamined: 0,
      statementsRecognized: 0,
      limitations: ["No affected dependency project was selected."],
    }]);
  });

  it("does not read a lockfile exceeding the default per-file ceiling", async () => {
    const readFile = vi.fn(async () => lock({}));
    const doctor = createDependenciesDoctor({ readFile });
    const result = await doctor.diagnose({
      snapshot: npmSnapshot({
        files: [
          { path: "package.json", kind: "file", size: 10 },
          { path: "package-lock.json", kind: "file", size: 20_000_001 },
        ],
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      limitations: [
        "package-lock.json: file exceeds the 20000000-byte dependency audit size limit.",
      ],
    })]);
  });

  it("turns read failures into path-only partial limitations", async () => {
    const seed = ["read", "-failure-", "credential-2Lm"].join("");
    const doctor = createDependenciesDoctor({
      readFile: async () => { throw new Error(seed); },
    });
    const result = await doctor.diagnose({
      snapshot: npmSnapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      limitations: ["package-lock.json: unable to read selected dependency metadata."],
    })]);
    expect(JSON.stringify(result)).not.toContain(seed);
  });

  it("stops before exceeding the total lockfile content budget", async () => {
    const readFile = vi.fn(async () => lock({ "": {} }));
    const doctor = createDependenciesDoctor({ readFile, maxTotalBytes: 120 });
    const base = npmSnapshot();
    const secondProject = {
      ...base.projects[0]!,
      id: "second",
      root: "second",
      manifestPaths: ["second/package.json"],
    };
    const result = await doctor.diagnose({
      snapshot: npmSnapshot({
        files: [
          { path: "package.json", kind: "file", size: 10 },
          { path: "package-lock.json", kind: "file", size: 100 },
          { path: "second/package.json", kind: "file", size: 10 },
          { path: "second/package-lock.json", kind: "file", size: 100 },
        ],
        manifests: [
          base.manifests[0]!,
          { ...base.manifests[0]!, path: "second/package.json" },
        ],
        projects: [base.projects[0]!, secondProject],
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(readFile).toHaveBeenCalledOnce();
    expect(result.coverage?.find(({ scope }) => scope === "full:second"))
      .toMatchObject({
        status: "partial",
        limitations: [
          "second/package-lock.json: total dependency audit content limit of 120 bytes was reached; remaining lockfiles were not examined.",
        ],
      });
  });

  it("caps findings per lock root and for the whole audit", async () => {
    const packages = Object.fromEntries([
      ["", {}],
      ...Array.from({ length: 5 }, (_, index) => [
        `node_modules/pkg-${index}`,
        { resolved: `https://packages.example.invalid/pkg-${index}.tgz` },
      ]),
    ]);
    const doctor = createDependenciesDoctor({
      readFile: async () => lock(packages),
      maxFindingsPerTarget: 3,
      maxFindings: 2,
    });
    const result = await doctor.diagnose({
      snapshot: npmSnapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toHaveLength(2);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      statementsRecognized: 2,
      limitations: expect.arrayContaining([
        "package-lock.json: dependency finding limit of 3 was reached; additional matches were withheld.",
        "Dependency audit finding limit of 2 was reached; additional matches and remaining lock roots were not reported.",
      ]),
    })]);
  });

  it("rejects invalid resource ceilings", () => {
    expect(() => createDependenciesDoctor({ maxFileBytes: 0 })).toThrow(/file.*positive/iu);
    expect(() => createDependenciesDoctor({ maxTotalBytes: 0 })).toThrow(/total.*positive/iu);
    expect(() => createDependenciesDoctor({ maxFindingsPerTarget: 0 })).toThrow(/per-target.*positive/iu);
    expect(() => createDependenciesDoctor({ maxFindings: 0 })).toThrow(/finding.*positive/iu);
  });
});
