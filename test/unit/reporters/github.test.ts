import { describe, expect, it } from "vitest";
import { createFingerprint, type Finding, type Severity } from "../../../src/core/findings.js";
import { renderGithubAnnotations } from "../../../src/reporters/github.js";

function finding(
  ruleId: string,
  severity: Severity,
  location?: { path: string; line?: number; column?: number },
): Finding {
  return {
    ruleId,
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "test",
    title: `${ruleId} title`,
    message: `${ruleId} message`,
    ...(location === undefined ? {} : { location }),
    evidence: [{ type: "observation", detail: ruleId }],
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId,
      ...(location === undefined ? {} : { location }),
      identity: ruleId,
    }),
  };
}

describe("renderGithubAnnotations", () => {
  it("maps severity to workflow commands with file and line", () => {
    const report = renderGithubAnnotations(
      [
        finding("bad", "high", { path: "src/a.ts", line: 3, column: 5 }),
        finding("warn", "medium", { path: "src/b.ts", line: 7 }),
        finding("note", "info"),
      ],
      { verdict: "REQUEST_CHANGES" },
    );

    expect(report).toContain("::error file=src/a.ts,line=3,col=5,title=[high] bad::");
    expect(report).toContain("::warning file=src/b.ts,line=7,");
    expect(report).toContain("::notice title=[info] note::");
    expect(report).toContain("verdict=REQUEST_CHANGES findings-in-diff=3");
  });

  it("escapes workflow command metacharacters", () => {
    const report = renderGithubAnnotations(
      [finding("weird\nrule:1,2%3", "low", { path: "src/a:b,c.ts", line: 1 })],
      { verdict: "COMMENT" },
    );

    expect(report).toContain("file=src/a%3Ab%2Cc.ts");
    expect(report.split("\n").filter((line) => line.startsWith("::"))).toHaveLength(2);
  });

  it("bounds annotations and reports the omission", () => {
    const report = renderGithubAnnotations(
      [
        finding("one", "high", { path: "a.ts", line: 1 }),
        finding("two", "high", { path: "b.ts", line: 1 }),
      ],
      { verdict: "REQUEST_CHANGES", maxFindings: 1, excludedCount: 4 },
    );

    expect(report).toContain("1 more finding(s) omitted");
    expect(report).toContain("omitted-outside-diff=4");
    expect(report).not.toContain("file=b.ts");
  });
});
