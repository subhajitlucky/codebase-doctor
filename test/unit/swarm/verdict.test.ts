import { describe, expect, it } from "vitest";
import type { DomainCoverage, DomainCoverageStatus } from "../../../src/core/domain-coverage.js";
import { composeFleetVerdict, composeRepoVerdict } from "../../../src/swarm/verdict.js";

function domain(domainName: DomainCoverage["domain"], status: DomainCoverageStatus): DomainCoverage {
  return {
    domain: domainName,
    applicability: "detected",
    status,
    coverageComplete: status === "completed" || status === "not-applicable",
    evidence: [],
    modules: [],
    limitations: [],
  };
}

describe("swarm verdict algebra", () => {
  it("rates gating findings above everything else", () => {
    const composition = composeRepoVerdict(
      [domain("security", "partial"), domain("database", "skipped")],
      2,
      0,
    );
    expect(composition.verdict).toBe("findings");
    expect(composition.unknownDomains).toEqual(["security: partial"]);
    expect(composition.gapDomains).toEqual(["database: skipped"]);
  });

  it("treats failed or partial coverage as unknown, never clean", () => {
    expect(composeRepoVerdict([domain("security", "partial")], 0, 0).verdict).toBe("unknown");
    expect(composeRepoVerdict([domain("backend", "failed")], 0, 0).verdict).toBe("unknown");
    expect(composeRepoVerdict([domain("security", "completed")], 0, 1).verdict).toBe("unknown");
  });

  it("reports documented gaps without claiming unknown", () => {
    const composition = composeRepoVerdict(
      [domain("validation", "skipped"), domain("database", "not-selected"), domain("ai", "unsupported")],
      0,
      0,
    );
    expect(composition.verdict).toBe("gaps");
    expect(composition.unknownDomains).toEqual([]);
    expect(composition.gapDomains).toEqual([
      "ai: unsupported",
      "database: not-selected",
      "validation: skipped",
    ]);
  });

  it("rates full applicable coverage as verified", () => {
    expect(
      composeRepoVerdict(
        [domain("repository", "completed"), domain("frontend", "not-applicable")],
        0,
        0,
      ).verdict,
    ).toBe("verified");
  });

  it("composes the fleet verdict as the worst of its members", () => {
    expect(composeFleetVerdict(["verified", "gaps", "unknown"])).toBe("unknown");
    expect(composeFleetVerdict(["verified", "gaps", "findings"])).toBe("findings");
    expect(composeFleetVerdict(["verified", "verified"])).toBe("verified");
    expect(composeFleetVerdict([])).toBe("verified");
  });
});
