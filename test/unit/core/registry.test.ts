import { describe, expect, it, vi } from "vitest";
import { buildAllowedCapabilities } from "../../../src/core/capabilities.js";
import type { Doctor, DoctorContext, DoctorResult } from "../../../src/core/doctor.js";
import { runDoctors } from "../../../src/core/registry.js";
import type { ProjectSnapshot } from "../../../src/workspace/types.js";

const snapshot: ProjectSnapshot = {
  root: "/tmp/example",
  files: [],
  manifests: [],
  projects: [],
  workspaces: [],
};

function completed(): DoctorResult {
  return { status: "completed", findings: [], durationMs: 1 };
}

function doctor(overrides: Partial<Doctor> & Pick<Doctor, "id">): Doctor {
  return {
    id: overrides.id,
    version: overrides.version ?? "0.1.0",
    capabilities: overrides.capabilities ?? ["filesystem:read"],
    supports: overrides.supports ?? (() => true),
    diagnose: overrides.diagnose ?? (async () => completed()),
  };
}

describe("allowed capabilities", () => {
  it("allows reads by default and execution only with explicit permission", () => {
    expect([...buildAllowedCapabilities({ runChecks: false })]).toEqual(["filesystem:read"]);
    expect([...buildAllowedCapabilities({ runChecks: true })]).toEqual([
      "filesystem:read",
      "process:execute",
    ]);
  });
});

describe("doctor registry", () => {
  it("runs a read-only doctor during a default scan", async () => {
    const diagnose = vi.fn(async (_context: DoctorContext) => completed());

    const [entry] = await runDoctors(
      [doctor({ id: "project", diagnose })],
      snapshot,
      { runChecks: false },
    );

    expect(entry).toMatchObject({ doctorId: "project", result: { status: "completed" } });
    expect(diagnose).toHaveBeenCalledOnce();
    expect([...diagnose.mock.calls[0]![0].allowedCapabilities]).toEqual(["filesystem:read"]);
  });

  it("skips process execution without permission and runs it with permission", async () => {
    const diagnose = vi.fn(async () => completed());
    const checkDoctor = doctor({
      id: "checks",
      capabilities: ["filesystem:read", "process:execute"],
      diagnose,
    });

    const [denied] = await runDoctors([checkDoctor], snapshot, { runChecks: false });
    const [allowed] = await runDoctors([checkDoctor], snapshot, { runChecks: true });

    expect(denied?.result).toMatchObject({
      status: "skipped",
      skipReason: expect.stringMatching(/process:execute/),
    });
    expect(allowed?.result.status).toBe("completed");
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it.each(["network:access", "filesystem:write"] as const)(
    "never grants %s in v0.1",
    async (forbiddenCapability) => {
      const diagnose = vi.fn(async () => completed());
      const [entry] = await runDoctors([
        doctor({ id: "unsafe", capabilities: [forbiddenCapability], diagnose }),
      ], snapshot, { runChecks: true });

      expect(entry?.result).toMatchObject({
        status: "skipped",
        skipReason: expect.stringContaining(forbiddenCapability),
      });
      expect(diagnose).not.toHaveBeenCalled();
    },
  );

  it("turns a thrown doctor error into operational metadata and continues", async () => {
    const laterDiagnose = vi.fn(async () => completed());
    const entries = await runDoctors([
      doctor({
        id: "broken",
        diagnose: async () => {
          throw new Error("scanner exploded");
        },
      }),
      doctor({ id: "later", diagnose: laterDiagnose }),
    ], snapshot, { runChecks: false });

    expect(entries[0]).toMatchObject({
      doctorId: "broken",
      result: {
        status: "failed",
        findings: [],
        error: { code: "doctor_execution_failed", message: "scanner exploded" },
      },
    });
    expect(entries[1]?.result.status).toBe("completed");
    expect(laterDiagnose).toHaveBeenCalledOnce();
  });

  it("returns an explained skip when a doctor does not support the snapshot", async () => {
    const diagnose = vi.fn(async () => completed());
    const [entry] = await runDoctors([
      doctor({ id: "unsupported", supports: () => false, diagnose }),
    ], snapshot, { runChecks: false });

    expect(entry?.result).toEqual({
      status: "skipped",
      findings: [],
      skipReason: "Doctor does not support this project snapshot.",
      durationMs: 0,
    });
    expect(diagnose).not.toHaveBeenCalled();
  });
});
