import { describe, expect, it } from "vitest";
import { createSecretsHistoryDoctor } from "../../../../src/audits/security/secrets-history/doctor.js";
import type { AuditCoverage } from "../../../../src/core/doctor.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../src/scope/types.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";
import {
  commitInitialContent,
  createTempProject,
  initializeGitRepository,
  removeTempProject,
  runGitFixtureCommand,
  writeProjectFile,
} from "../../../helpers/temp-project.js";

const secret = "f8K2mQ9xL4vN7pR1sT6uW3yZ0aB5cD";

function changedScope(): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes: [],
    affectedProjectIds: [],
    reasons: [],
    limitations: [],
  };
}

function snapshotWith(root: string, auditScope: AuditScope = fullAuditScope()): ProjectSnapshot {
  return {
    root,
    files: [],
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope,
  };
}

describe("Secrets History Doctor", () => {
  it("finds credentials removed from the working tree but still in history", async () => {
    const root = await createTempProject("codebase-doctor-history-");
    try {
      await initializeGitRepository(root);
      await commitInitialContent(root, {
        "src/app.ts": `export const apiKey = "${secret}";\n`,
      });
      await writeProjectFile(root, "src/app.ts", "export const apiKey = process.env.API_KEY;\n");
      await runGitFixtureCommand(root, ["add", "."]);
      await runGitFixtureCommand(root, ["commit", "-m", "remove credential"]);

      const doctor = createSecretsHistoryDoctor();
      const result = await doctor.diagnose({
        snapshot: snapshotWith(root),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      expect(result.status).toBe("completed");
      const finding = result.findings.find((entry) =>
        entry.ruleId.startsWith("security/secrets-history/")
      );
      expect(finding?.location?.path).toBe("src/app.ts");
      expect(finding?.severity).toBe("medium");
      expect(finding?.message).toMatch(/commit [0-9a-f]{7}/u);
      expect(JSON.stringify(result)).not.toContain(secret);

      const moduleCoverage = result.coverage?.find(
        (entry: AuditCoverage) => entry.moduleId === "security/secrets-history"
      );
      expect(moduleCoverage?.status).toBe("completed");
      expect(moduleCoverage?.statementsExamined).toBeGreaterThan(0);
      expect(moduleCoverage?.limitations.join(" ")).toContain("up to 200 commits");
    } finally {
      await removeTempProject(root);
    }
  });

  it("reports not-selected for changed audits", async () => {
    const root = await createTempProject("codebase-doctor-history-");
    try {
      await initializeGitRepository(root);
      await commitInitialContent(root, { "src/app.ts": "export const safe = true;\n" });

      const doctor = createSecretsHistoryDoctor();
      const result = await doctor.diagnose({
        snapshot: snapshotWith(root, changedScope()),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      expect(result.findings).toHaveLength(0);
      const moduleCoverage = result.coverage?.find(
        (entry: AuditCoverage) => entry.moduleId === "security/secrets-history"
      );
      expect(moduleCoverage?.status).toBe("not-selected");
      expect(moduleCoverage?.limitations.join(" ")).toContain("not selected for changed audits");
    } finally {
      await removeTempProject(root);
    }
  });

  it("keeps coverage partial when Git history is unavailable", async () => {
    const root = await createTempProject("codebase-doctor-history-");
    try {
      const doctor = createSecretsHistoryDoctor();
      const result = await doctor.diagnose({
        snapshot: snapshotWith(root),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      const moduleCoverage = result.coverage?.find(
        (entry: AuditCoverage) => entry.moduleId === "security/secrets-history"
      );
      expect(moduleCoverage?.status).toBe("partial");
      expect(moduleCoverage?.limitations.join(" ")).toContain("did not complete");
      expect(moduleCoverage?.limitations.join(" ")).toContain("not a clean result");
    } finally {
      await removeTempProject(root);
    }
  });

  it("deduplicates repeated occurrences of the same detector and path", async () => {
    const root = await createTempProject("codebase-doctor-history-");
    try {
      await initializeGitRepository(root);
      await commitInitialContent(root, {
        "config/keys.env": `API_KEY=${secret}\n`,
      });
      await writeProjectFile(root, "config/keys.env", `API_KEY=${secret}\nAPI_EXTRA=other\n`);
      await runGitFixtureCommand(root, ["add", "."]);
      await runGitFixtureCommand(root, ["commit", "-m", "touch credential file"]);

      const doctor = createSecretsHistoryDoctor();
      const result = await doctor.diagnose({
        snapshot: snapshotWith(root),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      const historyFindings = result.findings.filter((entry) =>
        entry.ruleId.startsWith("security/secrets-history/")
      );
      expect(historyFindings).toHaveLength(1);
      const fileEvidence = historyFindings[0]?.evidence.find(
        (entry) => entry.type === "file"
      );
      expect(fileEvidence?.detail).toMatch(/occurrence\(s\)/u);
    } finally {
      await removeTempProject(root);
    }
  });
});
