import { describe, expect, it, vi } from "vitest";
import type { Doctor, DoctorResult } from "../../../src/core/doctor.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import { scanCodebase, type ScanDependencies, type ScanRequest } from "../../../src/core/scan.js";
import type { FileInventory, ProjectDetection } from "../../../src/workspace/types.js";

const inventory: FileInventory = { root: "/repo", files: [] };
const detection: ProjectDetection = {
  projects: [{
    id: "root",
    root: ".",
    ecosystems: ["node"],
    languages: ["javascript"],
    frameworks: [],
    packageManager: "npm",
    manifestPaths: ["package.json"],
    executionSupport: "supported",
  }],
  workspaces: [],
};

function finding(): Finding {
  return {
    ruleId: "fixture/finding",
    doctorId: "project",
    severity: "medium",
    confidence: "high",
    category: "fixture",
    title: "Fixture finding",
    message: "Fixture message",
    evidence: [{ type: "observation", detail: "fixture" }],
    fingerprint: createFingerprint({
      doctorId: "project",
      ruleId: "fixture/finding",
      identity: "fixture",
    }),
  };
}

function doctor(
  id: string,
  capabilities: Doctor["capabilities"],
  diagnose: () => Promise<DoctorResult>,
): Doctor {
  return {
    id,
    version: "0.1.0",
    capabilities,
    supports: () => true,
    diagnose,
  };
}

function request(runChecks: boolean): ScanRequest {
  return {
    root: "/repo",
    runChecks,
    format: "json",
    timeoutMs: 1_000,
    failOn: "high",
  };
}

function dependencies(doctors: readonly Doctor[]): ScanDependencies {
  return {
    inventoryWorkspace: vi.fn(async () => inventory),
    loadManifests: vi.fn(async () => []),
    detectWorkspaceProjects: vi.fn(async () => detection),
    createDoctors: () => doctors,
  };
}

describe("scan orchestration", () => {
  it("builds one inventory and always runs the read-only Project Doctor", async () => {
    const diagnose = vi.fn(async () => ({
      status: "completed" as const,
      findings: [finding()],
      durationMs: 1,
    }));
    const deps = dependencies([doctor("project", ["filesystem:read"], diagnose)]);

    const result = await scanCodebase(request(false), deps);

    expect(deps.inventoryWorkspace).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(result.findings).toHaveLength(1);
  });

  it("skips Check Doctor by default and enables it with runChecks", async () => {
    const diagnose = vi.fn(async () => ({
      status: "completed" as const,
      findings: [],
      durationMs: 1,
    }));
    const check = doctor("checks", ["filesystem:read", "process:execute"], diagnose);

    const denied = await scanCodebase(request(false), dependencies([check]));
    const allowed = await scanCodebase(request(true), dependencies([check]));

    expect(denied.doctorRuns[0]).toMatchObject({ status: "skipped" });
    expect(allowed.doctorRuns[0]).toMatchObject({ status: "completed" });
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it("retains one doctor failure while preserving another doctor's finding", async () => {
    const broken = doctor("broken", ["filesystem:read"], async () => {
      throw new Error("doctor broke");
    });
    const healthy = doctor("healthy", ["filesystem:read"], async () => ({
      status: "completed",
      findings: [finding()],
      durationMs: 1,
    }));

    const result = await scanCodebase(request(false), dependencies([broken, healthy]));

    expect(result.findings).toHaveLength(1);
    expect(result.doctorRuns.find(({ doctorId }) => doctorId === "broken")).toMatchObject({
      status: "failed",
      error: { code: "doctor_execution_failed" },
    });
  });
});
