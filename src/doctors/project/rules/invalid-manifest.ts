import { createFingerprint, type Finding } from "../../../core/findings.js";
import type { ProjectSnapshot } from "../../../workspace/types.js";

export function findInvalidManifests(snapshot: ProjectSnapshot): Finding[] {
  return snapshot.manifests
    .filter((manifest) => manifest.status === "invalid")
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((manifest) => {
      const location = { path: manifest.path };
      return {
        ruleId: "repository/invalid-manifest",
        doctorId: "project",
        severity: "high",
        confidence: "high",
        category: "repository",
        title: "Invalid package manifest",
        message: `${manifest.path} could not be read as a package manifest.`,
        location,
        evidence: [{ type: "manifest", path: manifest.path, detail: manifest.error }],
        impact: "Project detection and dependency metadata can be incomplete or incorrect.",
        remediationConstraints: ["Preserve valid JSON and an object-valued package manifest root."],
        remediation: "Correct the JSON syntax and ensure the manifest root is an object.",
        verification: {
          command: "codebase-doctor audit . --format json",
          expected: "This fingerprint is absent and applicable repository audit coverage is completed.",
        },
        fingerprint: createFingerprint({
          doctorId: "project",
          ruleId: "repository/invalid-manifest",
          location,
          identity: "invalid-package-json",
        }),
      } satisfies Finding;
    });
}
