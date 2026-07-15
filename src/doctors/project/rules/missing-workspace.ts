import { createFingerprint, type Finding } from "../../../core/findings.js";
import type { ProjectSnapshot } from "../../../workspace/types.js";

export function findMissingWorkspaces(snapshot: ProjectSnapshot): Finding[] {
  return snapshot.workspaces
    .filter(({ supported, matchedProjectRoots }) => supported && matchedProjectRoots.length === 0)
    .sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) || left.pattern.localeCompare(right.pattern),
    )
    .map((workspace) => {
      const location = { path: workspace.sourcePath };
      return {
        ruleId: "repository/missing-workspace",
        doctorId: "project",
        severity: "medium",
        confidence: "high",
        category: "repository",
        title: "Workspace pattern has no matching project",
        message: `Workspace pattern ${workspace.pattern} matched no detected project.`,
        location,
        evidence: [{
          type: "manifest",
          path: workspace.sourcePath,
          detail: `Supported workspace pattern "${workspace.pattern}" has no match.`,
        }],
        remediation: "Create the expected workspace package or remove the stale workspace entry.",
        fingerprint: createFingerprint({
          doctorId: "project",
          ruleId: "repository/missing-workspace",
          location,
          identity: `${workspace.ownerProjectId}:${workspace.pattern}`,
        }),
      } satisfies Finding;
    });
}
