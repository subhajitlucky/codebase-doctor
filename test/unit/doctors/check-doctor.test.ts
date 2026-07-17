import { describe, expect, it, vi } from "vitest";
import { createCheckDoctor } from "../../../src/doctors/checks/doctor.js";
import type { CommandPlan, CommandRunResult } from "../../../src/execution/types.js";
import { fullAuditScope } from "../../../src/scope/planner.js";
import type { DetectedProject, ProjectSnapshot } from "../../../src/workspace/types.js";

function project(ecosystem: string): DetectedProject {
  return {
    id: "root",
    root: ".",
    ecosystems: [ecosystem],
    languages: [ecosystem === "node" ? "javascript" : ecosystem],
    frameworks: [],
    ...(ecosystem === "node" ? { packageManager: "npm" as const } : {}),
    manifestPaths: [ecosystem === "node" ? "package.json" : "pyproject.toml"],
    executionSupport: ecosystem === "node" || ecosystem === "python"
      ? "supported"
      : "detected-only",
  };
}

function nodeSnapshot(scripts: Record<string, string> = { test: "vitest" }): ProjectSnapshot {
  return {
    root: "/tmp/example",
    files: [{ path: "package.json", kind: "file", size: 1 }],
    manifests: [{
      kind: "package-json",
      path: "package.json",
      status: "valid",
      data: { scripts },
    }],
    projects: [project("node")],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

function snapshotFor(ecosystem: string): ProjectSnapshot {
  return { ...nodeSnapshot(), projects: [project(ecosystem)] };
}

function completed(overrides: Partial<Extract<CommandRunResult, { status: "completed" }>> = {}): CommandRunResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  };
}

function timedOut(): CommandRunResult {
  return {
    status: "timed-out",
    exitCode: null,
    signal: "SIGTERM",
    stdout: "still running",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 50,
  };
}

function failedToStart(): CommandRunResult {
  return {
    status: "failed-to-start",
    error: "spawn pytest ENOENT",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  };
}

const execute = new Set(["filesystem:read", "process:execute"] as const);

describe("Check Doctor", () => {
  it("supports executable Node and Python projects only", async () => {
    const doctor = createCheckDoctor({ runner: async () => completed() });

    await expect(doctor.supports(snapshotFor("node"))).resolves.toBe(true);
    await expect(doctor.supports(snapshotFor("python"))).resolves.toBe(true);
    await expect(doctor.supports(snapshotFor("go"))).resolves.toBe(false);
  });

  it("records a successful check without a failure finding", async () => {
    const runner = vi.fn(async (_plan: CommandPlan) => completed({ stdout: "all good\n" }));
    const doctor = createCheckDoctor({ runner });

    const result = await doctor.diagnose({ snapshot: nodeSnapshot(), allowedCapabilities: execute });

    expect(result.status).toBe("completed");
    expect(result.findings).toEqual([]);
    expect(result.checkRuns).toEqual([expect.objectContaining({ status: "passed", exitCode: 0 })]);
  });

  it("turns a non-zero validation exit into one high-severity finding", async () => {
    const doctor = createCheckDoctor({
      runner: async () => completed({ exitCode: 2, stdout: "2 tests failed\n" }),
    });

    const result = await doctor.diagnose({ snapshot: nodeSnapshot(), allowedCapabilities: execute });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: "checks/command-failed",
      severity: "high",
      confidence: "high",
      evidence: [{
        type: "command",
        command: "npm run test",
        exitCode: 2,
        output: "2 tests failed",
      }],
    });
  });

  it("turns a timeout into a medium-severity finding and operational result", async () => {
    const doctor = createCheckDoctor({ runner: async () => timedOut() });

    const result = await doctor.diagnose({ snapshot: nodeSnapshot(), allowedCapabilities: execute });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "check_timeout" });
    expect(result.findings[0]).toMatchObject({
      ruleId: "checks/command-timeout",
      severity: "medium",
      confidence: "high",
    });
    expect(result.checkRuns[0]).toMatchObject({ status: "timed-out" });
  });

  it("records a missing executable as a skipped check without a finding", async () => {
    const doctor = createCheckDoctor({ runner: async () => failedToStart() });

    const result = await doctor.diagnose({ snapshot: nodeSnapshot(), allowedCapabilities: execute });

    expect(result.findings).toEqual([]);
    expect(result.checkRuns).toEqual([expect.objectContaining({
      status: "skipped",
      reason: "spawn pytest ENOENT",
    })]);
  });

  it("redacts command output before storing evidence", async () => {
    const secret = "fixture-super-secret-token";
    const doctor = createCheckDoctor({
      runner: async () => completed({ exitCode: 1, stderr: `TOKEN=${secret}\n` }),
      redactionEnvironment: { BUILD_TOKEN: secret },
    });

    const result = await doctor.diagnose({ snapshot: nodeSnapshot(), allowedCapabilities: execute });
    const serialized = JSON.stringify(result.findings);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("never invokes the runner without process execution capability", async () => {
    const runner = vi.fn(async (_plan: CommandPlan) => completed());
    const doctor = createCheckDoctor({ runner });

    const result = await doctor.diagnose({
      snapshot: nodeSnapshot(),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result).toMatchObject({ status: "skipped", checkRuns: [] });
    expect(runner).not.toHaveBeenCalled();
  });

  it("executes multiple plans sequentially", async () => {
    let active = 0;
    let maximumActive = 0;
    const observed: string[] = [];
    const runner = async (plan: CommandPlan): Promise<CommandRunResult> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      observed.push(plan.args.at(-1)!);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return completed();
    };
    const doctor = createCheckDoctor({ runner });

    await doctor.diagnose({
      snapshot: nodeSnapshot({ test: "vitest", lint: "eslint ." }),
      allowedCapabilities: execute,
    });

    expect(observed).toEqual(["test", "lint"]);
    expect(maximumActive).toBe(1);
  });
});
