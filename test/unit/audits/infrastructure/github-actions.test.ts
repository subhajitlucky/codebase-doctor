import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkflow,
  createGitHubActionsDoctor,
  isWorkflowPath,
} from "../../../../src/audits/infrastructure/github-actions/doctor.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function snapshotWith(paths: readonly string[]): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 800 })),
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

describe("GitHub Actions workflow analysis", () => {
  it("flags attacker-controlled expressions interpolated into run steps", () => {
    const analysis = analyzeWorkflow(".github/workflows/pr.yml", [
      "on: pull_request",
      "jobs:",
      "  greet:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo \"${{ github.event.pull_request.title }}\"",
      "      - run: echo \"${{ github.head_ref }}\"",
      "      - env:",
      "          TITLE: ${{ github.event.pull_request.title }}",
      "        run: echo \"$TITLE\"",
      "      - run: echo \"${{ github.repository }}\"",
      "",
    ].join("\n"), false);

    const injections = analysis.findings.filter((entry) => entry.ruleId.endsWith("script-injection"));
    expect(injections).toHaveLength(2);
    expect(injections.every((entry) => entry.severity === "high")).toBe(true);
  });

  it("flags pull_request_target jobs that check out PR head code", () => {
    const analysis = analyzeWorkflow(".github/workflows/prt.yml", [
      "on: [pull_request_target]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
      "",
    ].join("\n"), false);

    expect(analysis.findings.map((entry) => entry.ruleId)).toEqual([
      "infrastructure/github-actions/pull-request-target-checkout",
    ]);

    const safe = analyzeWorkflow(".github/workflows/prt-safe.yml", [
      "on: pull_request_target",
      "jobs:",
      "  label:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n"), false);
    expect(safe.findings).toEqual([]);
  });

  it("flags write-all permissions and mutable action refs", () => {
    const analysis = analyzeWorkflow(".github/workflows/ci.yml", [
      "on: push",
      "permissions: read-all",
      "jobs:",
      "  test:",
      "    permissions: write-all",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: some/action@main",
      "      - uses: other/action@0123456789abcdef0123456789abcdef01234567",
      "      - uses: ./local-action",
      "      - uses: docker://alpine:3.20",
      "      - uses: scoped/action/.github/workflows/reuse.yml@feature/x",
      "",
    ].join("\n"), false);

    expect(analysis.findings.map((entry) => entry.ruleId).sort()).toEqual([
      "infrastructure/github-actions/unpinned-action",
      "infrastructure/github-actions/unpinned-action",
      "infrastructure/github-actions/write-all-permissions",
    ]);
    expect(analysis.stepsExamined).toBe(6);
  });

  it("reports invalid workflows as limitations", () => {
    const invalid = analyzeWorkflow(".github/workflows/ci.yml", "on: [push\n", false);
    expect(invalid.findings).toEqual([]);
    expect(invalid.limitations[0]).toContain("not valid YAML");

    const noJobs = analyzeWorkflow(".github/workflows/ci.yml", "on: push\n", false);
    expect(noJobs.limitations[0]).toContain("no jobs");
  });

  it("recognizes workflow path variants", () => {
    expect(isWorkflowPath(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowPath(".github/workflows/release.yaml")).toBe(true);
    expect(isWorkflowPath("workflows/ci.yml")).toBe(false);
    expect(isWorkflowPath(".github/actions/ci.yml")).toBe(false);
  });
});

describe("GitHub Actions Doctor", () => {
  it("reports not-applicable without workflows", async () => {
    const doctor = createGitHubActionsDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["src/index.ts"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "infrastructure/github-actions",
      status: "not-applicable",
    }));
  });

  it("reports workflow findings with completed coverage", async () => {
    const doctor = createGitHubActionsDoctor({
      readFile: async () => Buffer.from([
        "on: pull_request",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo \"${{ github.event.issue.title }}\"",
        "",
      ].join("\n")),
    });
    const result = await doctor.diagnose({
      snapshot: snapshotWith([".github/workflows/ci.yml"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });
    expect(result.findings.map((entry) => entry.ruleId)).toEqual([
      "infrastructure/github-actions/script-injection",
    ]);
    expect(result.coverage).toContainEqual(expect.objectContaining({
      moduleId: "infrastructure/github-actions",
      status: "completed",
      filesExamined: 1,
      statementsExamined: 1,
    }));
  });
});
