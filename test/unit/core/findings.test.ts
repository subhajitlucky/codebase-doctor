import { describe, expect, it } from "vitest";
import {
  compareFindings,
  createFingerprint,
  type Finding,
  sortFindings,
} from "../../../src/core/findings.js";

function finding(
  overrides: Partial<Pick<Finding, "doctorId" | "ruleId" | "severity">> & {
    path?: string;
    identity?: string;
  } = {},
): Finding {
  const doctorId = overrides.doctorId ?? "project";
  const ruleId = overrides.ruleId ?? "project/missing-tests";
  const path = overrides.path ?? "package.json";
  const identity = overrides.identity ?? "missing-test-script";

  return {
    ruleId,
    doctorId,
    severity: overrides.severity ?? "medium",
    confidence: "high",
    category: "quality",
    title: "Missing test command",
    message: "No test command was detected.",
    location: { path, line: 1, column: 1 },
    evidence: [{ type: "manifest", path, detail: "scripts.test is absent" }],
    remediation: "Add a test command.",
    impact: "Validation regressions can escape detection.",
    remediationConstraints: ["Keep the validation command deterministic and repository-local."],
    verification: {
      command: "codebase-doctor audit . --format json",
      expected: "The fingerprint is absent and applicable audit coverage is completed.",
    },
    fingerprint: createFingerprint({
      doctorId,
      ruleId,
      location: { path, line: 1, column: 1 },
      identity,
    }),
  };
}

describe("finding fingerprints", () => {
  it("is stable for identical logical input and normalized paths", () => {
    const first = createFingerprint({
      doctorId: "project",
      ruleId: "project/missing-tests",
      location: { path: "apps\\web\\package.json", line: 1 },
      identity: "missing-test-script",
    });
    const second = createFingerprint({
      doctorId: "project",
      ruleId: "project/missing-tests",
      location: { path: "apps/web/package.json", line: 1 },
      identity: "missing-test-script",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { ruleId: "project/no-readme" },
    { path: "packages/api/package.json" },
    { identity: "different-evidence" },
  ])("changes when logical identity changes: %o", (change) => {
    expect(finding(change).fingerprint).not.toBe(finding().fingerprint);
  });

  it("does not include model-oriented guidance in the fingerprint", () => {
    const original = finding();
    const changed = {
      ...original,
      impact: "Different impact wording.",
      remediationConstraints: ["A different invariant."],
      verification: { command: "codebase-doctor scan . --format json", expected: "Different expectation." },
    } satisfies Finding;

    expect(changed.fingerprint).toBe(original.fingerprint);
  });

  it("supports deterministic, nonempty, readonly guidance", () => {
    const first = finding();
    const second = finding();

    expect(first.impact?.trim()).not.toBe("");
    expect(first.remediationConstraints?.every((constraint) => constraint.trim().length > 0)).toBe(true);
    expect(first.verification?.command.trim()).not.toBe("");
    expect(first.verification?.expected.trim()).not.toBe("");
    expect(first).toEqual(second);
    expect(() => (Object.freeze(first.remediationConstraints) as string[] | undefined)?.push("mutation"))
      .toThrow();
  });
});

describe("finding ordering", () => {
  it("orders severity from critical through info", () => {
    const severities = ["low", "critical", "info", "high", "medium"] as const;

    expect(sortFindings(severities.map((severity) => finding({ severity }))).map(
      ({ severity }) => severity,
    )).toEqual(["critical", "high", "medium", "low", "info"]);
  });

  it("breaks ties by doctor, path, and rule", () => {
    const findings = [
      finding({ doctorId: "python", path: "z.py", ruleId: "b" }),
      finding({ doctorId: "project", path: "z.json", ruleId: "b" }),
      finding({ doctorId: "project", path: "a.json", ruleId: "z" }),
      finding({ doctorId: "project", path: "a.json", ruleId: "a" }),
    ];

    expect(sortFindings(findings).map(({ doctorId, location, ruleId }) =>
      `${doctorId}:${location?.path}:${ruleId}`,
    )).toEqual([
      "project:a.json:a",
      "project:a.json:z",
      "project:z.json:b",
      "python:z.py:b",
    ]);
    expect(findings[0]?.doctorId).toBe("python");
    expect(compareFindings(finding({ severity: "critical" }), finding())).toBeLessThan(0);
  });
});
