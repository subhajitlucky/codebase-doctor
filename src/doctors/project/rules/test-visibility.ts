import { posix } from "node:path";
import { createFingerprint, type Finding } from "../../../core/findings.js";
import type { ProjectSnapshot } from "../../../workspace/types.js";

function looksLikeTest(path: string): boolean {
  const segments = path.split("/");
  const basename = posix.basename(path);
  return segments.some((segment) =>
    segment === "test" || segment === "tests" || segment === "__tests__",
  ) ||
    /\.(?:test|spec)\.[^.]+$/.test(basename) ||
    /^test_.+\.py$/.test(basename) ||
    /_test\.go$/.test(basename);
}

export function findTestVisibility(snapshot: ProjectSnapshot): Finding[] {
  if (snapshot.projects.length === 0 || snapshot.files.some(({ kind, path }) =>
    kind === "file" && looksLikeTest(path),
  )) return [];

  return [{
    ruleId: "repository/no-visible-tests",
    doctorId: "project",
    severity: "info",
    confidence: "medium",
    category: "testing",
    title: "No visible tests",
    message: "No files matching common test naming conventions were visible in the repository inventory.",
    evidence: [{
      type: "observation",
      detail: `Inspected ${snapshot.files.length} inventory records without finding a common test path.`,
    }],
    impact: "Automated validation may be absent or undiscoverable to maintainers and tooling.",
    remediationConstraints: [
      "Add at least one test file in a recognized test path or with a common test filename pattern.",
    ],
    remediation: "Add automated tests in a recognized test path or using a common test naming pattern.",
    verification: {
      command: "codebase-doctor audit . --format json",
      expected: "This fingerprint is absent and applicable repository audit coverage is completed.",
    },
    fingerprint: createFingerprint({
      doctorId: "project",
      ruleId: "repository/no-visible-tests",
      identity: "repository-no-visible-tests",
    }),
  }];
}
