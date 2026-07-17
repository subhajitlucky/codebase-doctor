import { describe, expect, it } from "vitest";
import { projectDoctor } from "../../../src/doctors/project/doctor.js";
import { findConflictingLockfiles } from "../../../src/doctors/project/rules/conflicting-lockfiles.js";
import { findInvalidManifests } from "../../../src/doctors/project/rules/invalid-manifest.js";
import { findMissingWorkspaces } from "../../../src/doctors/project/rules/missing-workspace.js";
import { findTestVisibility } from "../../../src/doctors/project/rules/test-visibility.js";
import { fullAuditScope } from "../../../src/scope/planner.js";
import type {
  DetectedProject,
  FileRecord,
  ProjectSnapshot,
  WorkspaceRecord,
} from "../../../src/workspace/types.js";
import type { Finding } from "../../../src/core/findings.js";

function expectGuidance(finding: Finding | undefined): void {
  expect(finding).toMatchObject({
    impact: expect.any(String),
    remediationConstraints: [expect.any(String)],
    verification: {
      command: "codebase-doctor audit . --format json",
      expected: expect.stringMatching(/fingerprint.*absent.*coverage.*completed/i),
    },
  });
}

function project(root = ".", packageManager?: DetectedProject["packageManager"]): DetectedProject {
  return {
    id: root === "." ? "root" : `project:${root}`,
    root,
    ecosystems: ["node"],
    languages: ["javascript"],
    frameworks: [],
    ...(packageManager === undefined ? {} : { packageManager }),
    manifestPaths: [root === "." ? "package.json" : `${root}/package.json`],
    executionSupport: "supported",
  };
}

function file(path: string): FileRecord {
  return { path, kind: "file", size: 10 };
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/tmp/example",
    files: [file("package.json")],
    manifests: [{ kind: "package-json", path: "package.json", status: "valid", data: {} }],
    projects: [project()],
    workspaces: [],
    auditScope: fullAuditScope(),
    ...overrides,
  };
}

describe("Project Doctor rules", () => {
  it("reports competing manager lockfiles in one project boundary", () => {
    const findings = findConflictingLockfiles(snapshot({
      files: [file("package.json"), file("package-lock.json"), file("yarn.lock")],
    }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "repository/conflicting-lockfiles",
      severity: "medium",
      confidence: "high",
      evidence: [
        { type: "file", path: "package-lock.json" },
        { type: "file", path: "yarn.lock" },
      ],
    });
    expectGuidance(findings[0]);
  });

  it("does not confuse package lockfiles across pnpm workspace boundaries", () => {
    const findings = findConflictingLockfiles(snapshot({
      files: [
        file("package.json"),
        file("pnpm-lock.yaml"),
        file("apps/web/package.json"),
        file("apps/web/package-lock.json"),
        file("packages/api/package.json"),
        file("packages/api/package-lock.json"),
      ],
      projects: [project(".", "pnpm"), project("apps/web", "npm"), project("packages/api", "npm")],
      workspaces: [{
        ownerProjectId: "root",
        sourcePath: "pnpm-workspace.yaml",
        pattern: "packages/*",
        supported: true,
        matchedProjectRoots: ["packages/api"],
      }],
    }));

    expect(findings).toEqual([]);
  });

  it("reports each invalid package manifest with parse evidence", () => {
    const findings = findInvalidManifests(snapshot({
      manifests: [{
        kind: "package-json",
        path: "apps/web/package.json",
        status: "invalid",
        error: "Expected property name at position 2",
      }],
    }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "repository/invalid-manifest",
      severity: "high",
      confidence: "high",
      location: { path: "apps/web/package.json" },
      evidence: [{
        type: "manifest",
        path: "apps/web/package.json",
        detail: "Expected property name at position 2",
      }],
    });
    expectGuidance(findings[0]);
  });

  it("reports supported workspace patterns with no detected match", () => {
    const workspaces: WorkspaceRecord[] = [
      {
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "packages/*",
        supported: true,
        matchedProjectRoots: [],
      },
      {
        ownerProjectId: "root",
        sourcePath: "package.json",
        pattern: "packages/**",
        supported: false,
        matchedProjectRoots: [],
      },
    ];

    const findings = findMissingWorkspaces(snapshot({ workspaces }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "repository/missing-workspace",
      severity: "medium",
      confidence: "high",
      location: { path: "package.json" },
      evidence: [{ type: "manifest", path: "package.json" }],
    });
    expectGuidance(findings[0]);
  });

  it("reports absent tests as informational and accepts common test paths", () => {
    const missing = findTestVisibility(snapshot({
      files: [file("package.json"), file("src/index.ts")],
    }));
    const visible = findTestVisibility(snapshot({
      files: [file("package.json"), file("src/index.ts"), file("test/index.test.ts")],
    }));

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      ruleId: "repository/no-visible-tests",
      severity: "info",
      confidence: "medium",
      remediation: expect.stringMatching(/recognized test path|common test naming/i),
      remediationConstraints: [expect.stringMatching(/recognized test path|common test naming/i)],
    });
    expect(missing[0]?.remediation).not.toMatch(/document|non-standard/i);
    expect(missing[0]?.remediationConstraints?.join(" ")).not.toMatch(/document|non-standard/i);
    expectGuidance(missing[0]);
    expect(visible).toEqual([]);
  });
});

describe("Project Doctor composition", () => {
  it("combines pure rules without reading beyond the snapshot", async () => {
    const result = await projectDoctor.diagnose({
      snapshot: snapshot({
        files: [file("package.json"), file("package-lock.json"), file("yarn.lock")],
        manifests: [{
          kind: "package-json",
          path: "package.json",
          status: "invalid",
          error: "broken JSON",
        }],
      }),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual([
      "repository/invalid-manifest",
      "repository/conflicting-lockfiles",
      "repository/no-visible-tests",
    ]);
  });
});
