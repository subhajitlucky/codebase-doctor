import { afterEach, describe, expect, it } from "vitest";
import {
  BaselineError,
  compareFindings,
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
    const comparison = compareFindings(
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
