import { describe, expect, it } from "vitest";
import type { RegisteredDoctorResult } from "../../../src/core/doctor.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import { normalizeScanResult } from "../../../src/core/normalize.js";
import { renderMarkdownReview } from "../../../src/reporters/markdown.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function finding(
  ruleId: string,
  path = "src/a.ts",
  line = 12,
): Finding {
  return {
    ruleId,
    doctorId: "security/secrets",
    severity: "high",
    confidence: "high",
    category: "security",
    title: `${ruleId} title`,
    message: `${ruleId} message with evidence withheld`,
    location: { path, line },
    evidence: [{ type: "file", path, detail: "matched; the value was withheld" }],
    remediation: `Fix ${ruleId} and rerun the audit.`,
    fingerprint: createFingerprint({
      doctorId: "security/secrets",
      ruleId,
      location: { path, line },
      identity: ruleId,
    }),
  };
}

function scanResult(findings: Finding[]) {
  const run: RegisteredDoctorResult = {
    doctorId: "security/secrets",
    result: { status: "completed", findings, durationMs: 0 },
  };
  return normalizeScanResult("/repo", [], fullAuditScope(), [run], [], []);
}

describe("renderMarkdownReview", () => {
  it("leads with the verdict and renders diff findings with locations", () => {
    const inDiff = [finding("security/secrets/provider-token")];
    const report = renderMarkdownReview(scanResult(inDiff), inDiff, {
      verdict: "REQUEST_CHANGES",
      failOn: "high",
      excludedCount: 2,
    });

    expect(report).toContain("## Codebase Doctor Review — 🔴 REQUEST_CHANGES");
    expect(report).toContain("findings in diff: 1");
    expect(report).toContain("`security/secrets/provider-token`");
    expect(report).toContain("`src/a.ts:12`");
    expect(report).toContain("2 finding(s) outside the changed lines are omitted");
    expect(report).toContain("### Coverage limitations");
    expect(report).toContain("Models build. Codebase Doctor verifies.");
  });

  it("states an empty diff honestly and bounds long output", () => {
    const report = renderMarkdownReview(scanResult([]), [], {
      verdict: "APPROVE",
      failOn: "high",
      maxFindings: 1,
    });

    expect(report).toContain("🟢 APPROVE");
    expect(report).toContain("No findings in scope.");
  });

  it("truncates beyond the finding budget", () => {
    const findings = [finding("one"), finding("two")];
    const report = renderMarkdownReview(scanResult(findings), findings, {
      verdict: "REQUEST_CHANGES",
      failOn: "high",
      maxFindings: 1,
    });

    expect(report).toContain("1 more finding(s)");
    expect(report).not.toContain("two title");
  });
});
