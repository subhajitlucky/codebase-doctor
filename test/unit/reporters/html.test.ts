import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import type { DomainCoverage } from "../../../src/core/domain-coverage.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import { normalizeScanResult, type ScanResult } from "../../../src/core/normalize.js";
import { renderHtmlReport } from "../../../src/reporters/html.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function finding(): Finding {
  return {
    ruleId: "fixture/high",
    doctorId: "fixture",
    severity: "high",
    confidence: "high",
    category: "test",
    title: "High finding",
    message: "Unsafe <script>alert('x')</script> & value",
    location: { path: "src/<config>.ts", line: 6 },
    evidence: [{ type: "observation", detail: "high" }],
    remediation: "Remove <script> tags.",
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId: "fixture/high",
      identity: "high",
    }),
  };
}

const incompleteCoverage: DomainCoverage[] = [
  {
    domain: "security",
    applicability: "unknown",
    status: "unsupported",
    coverageComplete: false,
    evidence: [],
    modules: [],
    limitations: ["General security analysis is not implemented."],
  },
];

function scan(): ScanResult {
  const registered: RegisteredDoctorResult = {
    doctorId: "fixture",
    result: {
      status: "completed",
      durationMs: 0,
      findings: [finding()],
    } satisfies DoctorResult,
  };
  return normalizeScanResult("/repo", [], fullAuditScope(), [registered], [], incompleteCoverage);
}

describe("HTML reporter", () => {
  it("renders a standalone report with score, findings, and coverage", () => {
    const html = renderHtmlReport(scan());

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Codebase Doctor report</title>");
    expect(html).toContain("Repo Health");
    expect(html).toContain("80<span>/100</span>");
    expect(html).toContain("fixture/high");
    expect(html).toContain("security: unsupported");
    expect(html).toContain("Coverage: incomplete");
  });

  it("escapes repository-controlled content", () => {
    const html = renderHtmlReport(scan());

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; value");
    expect(html).toContain("src/&lt;config&gt;.ts:6");
    expect(html).toContain("Remove &lt;script&gt; tags.");
  });
});
