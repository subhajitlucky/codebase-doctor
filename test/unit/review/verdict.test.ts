import { describe, expect, it } from "vitest";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import {
  classifyReviewExit,
  decideReviewVerdict,
  selectVerdictFindings,
} from "../../../src/review/verdict.js";

function finding(ruleId: string, severity: Finding["severity"] = "high"): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: ruleId,
    message: ruleId,
    location: { path: "src/a.ts", line: 1 },
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId,
      location: { path: "src/a.ts", line: 1 },
      identity: ruleId,
    }),
  };
}

describe("decideReviewVerdict", () => {
  it("requests changes at or above the threshold", () => {
    expect(decideReviewVerdict([finding("a", "high")], "high")).toBe("REQUEST_CHANGES");
    expect(decideReviewVerdict([finding("a", "critical")], "high")).toBe("REQUEST_CHANGES");
  });

  it("comments below the threshold and approves an empty diff", () => {
    expect(decideReviewVerdict([finding("a", "medium")], "high")).toBe("COMMENT");
    expect(decideReviewVerdict([], "high")).toBe("APPROVE");
  });

  it("never requests changes when the threshold is none", () => {
    expect(decideReviewVerdict([finding("a", "critical")], "none")).toBe("COMMENT");
    expect(decideReviewVerdict([], "none")).toBe("APPROVE");
  });
});

describe("selectVerdictFindings", () => {
  it("keeps only new findings when a baseline comparison exists", () => {
    const old = finding("old");
    const fresh = finding("fresh");

    expect(selectVerdictFindings([old, fresh], [fresh.fingerprint])).toEqual([fresh]);
    expect(selectVerdictFindings([old, fresh], undefined)).toEqual([old, fresh]);
  });
});

describe("classifyReviewExit", () => {
  it("fails operationally before evaluating the threshold", () => {
    expect(classifyReviewExit([], "high", true, true)).toBe(2);
    expect(classifyReviewExit([], "high", false, false, { requireComplete: true })).toBe(2);
    expect(classifyReviewExit([], "high", false, false)).toBe(0);
  });

  it("requests changes only when the verdict set meets the threshold", () => {
    expect(classifyReviewExit([finding("a", "high")], "high", false, true)).toBe(1);
    expect(classifyReviewExit([finding("a", "medium")], "high", false, true)).toBe(0);
  });
});
