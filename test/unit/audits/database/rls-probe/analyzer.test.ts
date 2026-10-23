import { describe, expect, it } from "vitest";
import { analyzeProbeResults } from "../../../../../src/audits/database/rls-probe/analyzer.js";
import { mapProbeFindings } from "../../../../../src/audits/database/rls-probe/mapper.js";
import type { ProbeRunResult } from "../../../../../src/audits/database/rls-probe/types.js";

const run: ProbeRunResult = {
  roleErrors: [{ role: "missing_role", message: "role does not exist" }],
  probes: [
    {
      role: "authenticated",
      subject: "00000000-0000-0000-0000-000000000002",
      schema: "public",
      table: "orders",
      status: "rows",
      sampledRows: 10,
      ownerColumn: "owner_id",
      distinctOwners: 2,
      ownRows: 4,
      foreignRows: 6,
      error: null,
      sessionDependentSettings: [],
    },
    {
      role: "authenticated",
      subject: null,
      schema: "public",
      table: "accounts",
      status: "rows",
      sampledRows: 3,
      ownerColumn: "tenant_id",
      distinctOwners: 3,
      ownRows: null,
      foreignRows: null,
      error: null,
      sessionDependentSettings: ["app.tenant_id"],
    },
    {
      role: "authenticated",
      subject: null,
      schema: "public",
      table: "private",
      status: "denied",
      sampledRows: 0,
      ownerColumn: null,
      distinctOwners: null,
      ownRows: null,
      foreignRows: null,
      error: null,
      sessionDependentSettings: [],
    },
  ],
};

describe("RLS probe analyzer", () => {
  it("reports cross-subject reads as high severity", () => {
    const report = analyzeProbeResults(run, {
      schemas: ["public"],
      roles: ["authenticated"],
    });
    const finding = report.findings.find(({ id }) => id === "probe-cross-subject-read");

    expect(finding).toMatchObject({
      severity: "high",
      schema: "public",
      table: "orders",
    });
    expect(report.summary.highestSeverity).toBe("high");
    expect(report.summary.byStatus.rows).toBe(2);
  });

  it("reports role errors and session-dependent policies without inventing a clean result", () => {
    const report = analyzeProbeResults(run, {
      schemas: ["public"],
      roles: ["authenticated"],
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "probe-role-unavailable",
      severity: "medium",
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "probe-session-dependent-policy",
      severity: "medium",
      table: "accounts",
    }));
  });

  it("maps probe findings into stable proof findings without file locations", () => {
    const report = analyzeProbeResults(run, {
      schemas: ["public"],
      roles: ["authenticated"],
    });
    const findings = mapProbeFindings(report);
    const crossSubject = findings.find(({ ruleId }) =>
      ruleId === "database/rls-probe/probe-cross-subject-read"
    );

    expect(crossSubject).toMatchObject({
      severity: "high",
      doctorId: "database/rls-probe",
      category: "database-security",
    });
    expect(crossSubject?.location).toBeUndefined();
    expect(crossSubject?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(findings.some(({ ruleId }) => ruleId.endsWith("/probe-read-denied"))).toBe(true);
  });
});
