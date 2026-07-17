import { afterEach, describe, expect, it } from "vitest";
import {
  BaselineError,
  compareFindingBaseline,
  loadBaseline,
} from "../../../src/core/baseline.js";
import type { Finding, Severity } from "../../../src/core/findings.js";
import {
  createTempProject,
  removeTempProject,
  writeProjectFile,
} from "../../helpers/temp-project.js";

const roots: string[] = [];

function finding(fingerprint: string, severity: Severity = "high"): Finding {
  return {
    ruleId: "fixture/rule",
    doctorId: "fixture",
    severity,
    confidence: "high",
    category: "fixture",
    title: fingerprint,
    message: fingerprint,
    evidence: [{ type: "observation", detail: fingerprint }],
    fingerprint,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempProject));
});

describe("baseline comparison", () => {
  it("classifies fingerprints and summarizes only new findings", () => {
    const comparison = compareFindingBaseline(
      [finding("same"), finding("new-medium", "medium")],
      [finding("resolved"), finding("same")],
    );

    expect(comparison).toEqual({
      new: ["new-medium"],
      unchanged: ["same"],
      resolved: ["resolved"],
      newSummary: {
        total: 1,
        counts: { info: 0, low: 0, medium: 1, high: 0, critical: 0 },
        highestSeverity: "medium",
      },
    });
  });

  it("remains fingerprint-based when guidance text changes", () => {
    const current = {
      ...finding("same"),
      impact: "Current impact wording.",
      remediationConstraints: ["Current invariant."],
      verification: {
        command: "codebase-doctor audit . --format json",
        expected: "The fingerprint is absent and applicable coverage is completed.",
      },
    } satisfies Finding;
    const baseline = {
      ...finding("same"),
      impact: "Previous impact wording.",
      remediationConstraints: ["Previous invariant."],
      verification: {
        command: "codebase-doctor scan . --format json",
        expected: "Previous expectation.",
      },
    } satisfies Finding;

    expect(compareFindingBaseline([current], [baseline])).toMatchObject({
      new: [],
      unchanged: ["same"],
      resolved: [],
    });
  });

  it("can conservatively omit resolved classifications for a partial scope", () => {
    const comparison = compareFindingBaseline(
      [finding("same"), finding("new-high")],
      [finding("out-of-scope"), finding("same")],
      { includeResolved: false },
    );

    expect(comparison.new).toEqual(["new-high"]);
    expect(comparison.unchanged).toEqual(["same"]);
    expect(comparison.resolved).toEqual([]);
    expect(comparison.newSummary).toMatchObject({
      total: 1,
      highestSeverity: "high",
    });
  });

  it("loads a schema-1 Codebase Doctor report", async () => {
    const root = await createTempProject();
    roots.push(root);
    await writeProjectFile(root, "baseline.json", JSON.stringify({
      schemaVersion: "1",
      tool: { name: "codebase-doctor", version: "0.1.1" },
      findings: [finding("known")],
    }));

    await expect(loadBaseline(`${root}/baseline.json`)).resolves.toMatchObject({
      findings: [expect.objectContaining({ fingerprint: "known" })],
    });
  });

  it("rejects incompatible reports", async () => {
    const root = await createTempProject();
    roots.push(root);
    await writeProjectFile(root, "baseline.json", JSON.stringify({
      schemaVersion: "2",
      tool: { name: "another-tool" },
      findings: [],
    }));

    await expect(loadBaseline(`${root}/baseline.json`)).rejects.toBeInstanceOf(BaselineError);
  });
});
