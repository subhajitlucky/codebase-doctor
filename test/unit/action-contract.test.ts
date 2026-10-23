import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ActionInput {
  default?: string;
}

interface ActionStep {
  name?: string;
  if?: string;
}

interface ActionManifest {
  inputs: Record<string, ActionInput>;
  runs: { steps: ActionStep[] };
}

const action = parse(readFileSync("action.yml", "utf8")) as ActionManifest;

describe("GitHub Action contract", () => {
  it("installs a pinned package version on Node 22", () => {
    expect(action.inputs["node-version"]?.default).toBe("22");
    expect(action.inputs["version"]?.default).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(action.inputs["version"]?.default).not.toBe("latest");
  });

  it("exposes the CLI capabilities that matter for proof and live RLS", () => {
    for (const name of [
      "with-database",
      "with-probe",
      "app-roles",
      "subjects",
      "owner-columns",
      "probe-sample-limit",
      "database-schema",
      "with-advisories",
      "receipt",
      "require-base",
    ]) {
      expect(action.inputs[name], `missing action input ${name}`).toBeDefined();
    }
  });

  it("uploads findings and receipts even when the audit gates the job", () => {
    for (const stepName of [
      "Upload receipt",
      "Comment PR with review",
      "Upload SARIF to code scanning",
    ]) {
      const step = action.runs.steps.find(({ name }) => name === stepName);
      expect(step, `missing action step ${stepName}`).toBeDefined();
      expect(step?.if, `${stepName} must run after a failing audit`).toContain("always()");
    }
  });
});
