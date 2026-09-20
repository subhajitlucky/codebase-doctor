import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { advisoryFindings } from "../../../../src/audits/security/advisories/analyzer.js";
import { createAdvisoriesDoctor } from "../../../../src/audits/security/advisories/doctor.js";
import {
  packageNameFromLockPath,
  scanResolvedPackages
} from "../../../../src/audits/security/advisories/parser.js";
import type { OsvAdvisory, OsvClient, OsvQuery } from "../../../../src/audits/security/advisories/osv.js";
import { buildAllowedCapabilities } from "../../../../src/core/capabilities.js";
import type { AuditCoverage } from "../../../../src/core/doctor.js";
import type { Finding } from "../../../../src/core/findings.js";
import { runDoctors } from "../../../../src/core/registry.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function npmSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    root: "/repo",
    files: [
      { path: "package.json", kind: "file", size: 100 },
      { path: "package-lock.json", kind: "file", size: 500 },
    ],
    manifests: [
      {
        kind: "package-json",
        path: "package.json",
        status: "valid",
        data: { dependencies: { alpha: "^1.0.0" } },
      },
    ],
    projects: [
      {
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
      },
    ],
    workspaces: [],
    auditScope: fullAuditScope(),
    ...overrides,
  };
}

function lock(packages: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ lockfileVersion: 3, packages }));
}

const advisory: OsvAdvisory = {
  id: "GHSA-test-0000-0000",
  summary: "Alpha mishandles input.",
  severity: "high",
  fixedIn: "1.0.1",
  aliases: ["CVE-2026-0000"],
};

function fakeClient(advisories: readonly OsvAdvisory[]): OsvClient {
  return {
    lookup: async (packages: readonly OsvQuery[]) => ({
      status: "completed",
      results: packages.map((pkg) => ({ package: pkg, advisories })),
      limitations: [],
    }),
  };
}

const networkCapabilities = new Set(["filesystem:read", "network:advisories"] as const);

describe("advisory lock parsing", () => {
  it("extracts resolved registry package names and versions", () => {
    const scan = scanResolvedPackages(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture" },
          "node_modules/alpha": { version: "1.0.0" },
          "node_modules/@scope/beta": { version: "2.3.4" },
          "node_modules/alpha/node_modules/nested": { version: "0.1.0" },
          "node_modules/linked": { link: true },
          "node_modules/workspace-pkg": { version: "file:../workspace-pkg" },
          "node_modules/loose": { version: "latest" },
        },
      }),
    );

    expect(scan.status).toBe("supported");
    expect(scan.packages).toEqual([
      { name: "@scope/beta", version: "2.3.4" },
      { name: "alpha", version: "1.0.0" },
      { name: "nested", version: "0.1.0" },
    ]);
  });

  it("reports invalid JSON and unsupported lockfile versions", () => {
    expect(scanResolvedPackages("{not json").status).toBe("invalid");
    expect(scanResolvedPackages(JSON.stringify({ lockfileVersion: 1 })).status).toBe(
      "unsupported",
    );
  });

  it("derives package names from lock paths", () => {
    expect(packageNameFromLockPath("node_modules/@scope/pkg")).toBe("@scope/pkg");
    expect(packageNameFromLockPath("node_modules/a/node_modules/b")).toBe("b");
    expect(packageNameFromLockPath("")).toBeUndefined();
    expect(packageNameFromLockPath("node_modules")).toBeUndefined();
    expect(packageNameFromLockPath("packages/app")).toBeUndefined();
  });
});

describe("advisory findings", () => {
  it("maps advisory severity and carries the fixed version", () => {
    const findings = advisoryFindings({
      lockPath: "package-lock.json",
      changed: false,
      advisories: [{ package: { name: "alpha", version: "1.0.0" }, advisories: [advisory] }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "security/advisories/vulnerable-dependency",
      doctorId: "security/advisories",
      severity: "high",
      confidence: "high",
    });
    expect(findings[0]?.message).toContain("GHSA-test-0000-0000");
    expect(findings[0]?.remediation).toContain("1.0.1");
    expect(findings[0]?.verification?.command).toContain("--with-advisories");
  });

  it("emits one finding per advisory for the same package", () => {
    const second: OsvAdvisory = { ...advisory, id: "CVE-2026-0001", severity: "critical" };
    const findings = advisoryFindings({
      lockPath: "package-lock.json",
      changed: true,
      advisories: [
        { package: { name: "alpha", version: "1.0.0" }, advisories: [advisory, second] },
      ],
    });

    expect(findings.map((finding: Finding) => finding.severity).sort()).toEqual(["critical", "high"]);
    expect(new Set(findings.map((finding: Finding) => finding.fingerprint)).size).toBe(2);
  });
});

describe("Advisories Doctor", () => {
  it("declares the network capability and produces findings for vulnerable packages", async () => {
    const doctor = createAdvisoriesDoctor({
      readFile: async () => lock({ "node_modules/alpha": { version: "1.0.0" } }),
      client: fakeClient([advisory]),
    });

    expect(doctor.capabilities).toEqual(["filesystem:read", "network:advisories"]);

    const result = await doctor.diagnose({
      snapshot: npmSnapshot(),
      allowedCapabilities: networkCapabilities,
    });

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("high");
    const moduleCoverage = result.coverage?.find((entry: AuditCoverage) => entry.moduleId === "security/advisories");
    expect(moduleCoverage).toMatchObject({ status: "completed", statementsExamined: 1 });
    expect(moduleCoverage?.limitations.join(" ")).toContain("point-in-time");
  });

  it("keeps coverage partial and emits no findings when the lookup fails", async () => {
    const doctor = createAdvisoriesDoctor({
      readFile: async () => lock({ "node_modules/alpha": { version: "1.0.0" } }),
      client: { lookup: async () => ({ status: "failed", message: "network unreachable" }) },
    });

    const result = await doctor.diagnose({
      snapshot: npmSnapshot(),
      allowedCapabilities: networkCapabilities,
    });

    expect(result.findings).toHaveLength(0);
    const moduleCoverage = result.coverage?.find((entry: AuditCoverage) => entry.moduleId === "security/advisories");
    expect(moduleCoverage?.status).toBe("partial");
    expect(moduleCoverage?.limitations.join(" ")).toContain("did not complete");
    expect(moduleCoverage?.limitations.join(" ")).toContain("not a clean result");
  });

  it("is skipped by the registry when network access is not granted", async () => {
    const doctor = createAdvisoriesDoctor({
      readFile: async () => lock({ "node_modules/alpha": { version: "1.0.0" } }),
      client: fakeClient([advisory]),
    });
    const diagnose = vi.spyOn(doctor, "diagnose");

    const [registered] = await runDoctors([doctor], npmSnapshot(), { runChecks: false });

    expect(registered?.result.status).toBe("skipped");
    expect(registered?.result.skipReason).toContain("network:advisories");
    expect(diagnose).not.toHaveBeenCalled();
  });

  it("reports not-applicable when no npm lock target exists", async () => {
    const doctor = createAdvisoriesDoctor({
      readFile: async () => lock({}),
      client: fakeClient([]),
    });

    const result = await doctor.diagnose({
      snapshot: npmSnapshot({ files: [], projects: [], manifests: [] }),
      allowedCapabilities: networkCapabilities,
    });

    const moduleCoverage = result.coverage?.find((entry: AuditCoverage) => entry.moduleId === "security/advisories");
    expect(moduleCoverage?.status).toBe("not-applicable");
  });
});

describe("advisory capability gating", () => {
  it("grants network access only with an explicit permission", () => {
    expect(buildAllowedCapabilities({ runChecks: false }).has("network:advisories")).toBe(false);
    expect(
      buildAllowedCapabilities({ runChecks: false, withAdvisories: true }).has("network:advisories"),
    ).toBe(true);
    expect(
      buildAllowedCapabilities({ runChecks: false, withAdvisories: true }).has("network:access"),
    ).toBe(false);
    expect(
      buildAllowedCapabilities({ runChecks: false, withDatabase: true }).has("network:access"),
    ).toBe(true);
  });
});
