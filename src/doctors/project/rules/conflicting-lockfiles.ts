import { posix } from "node:path";
import { createFingerprint, type Evidence, type Finding } from "../../../core/findings.js";
import type { PackageManager, ProjectSnapshot } from "../../../workspace/types.js";

const LOCKFILE_MANAGERS: Readonly<Record<string, PackageManager>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

export function findConflictingLockfiles(snapshot: ProjectSnapshot): Finding[] {
  const findings: Finding[] = [];

  for (const project of snapshot.projects) {
    const lockfiles = snapshot.files
      .filter(({ kind, path }) =>
        kind === "file" &&
        (posix.dirname(path) === project.root ||
          (project.root === "." && posix.dirname(path) === ".")) &&
        posix.basename(path) in LOCKFILE_MANAGERS,
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    const managers = [...new Set(lockfiles.map(({ path }) =>
      LOCKFILE_MANAGERS[posix.basename(path)]!,
    ))].sort();
    if (managers.length < 2) continue;

    const evidence: Evidence[] = lockfiles.map(({ path }) => ({
      type: "file",
      path,
      detail: `${LOCKFILE_MANAGERS[posix.basename(path)]} package-manager lockfile.`,
    }));
    const location = { path: lockfiles[0]!.path };
    findings.push({
      ruleId: "repository/conflicting-lockfiles",
      doctorId: "project",
      severity: "medium",
      confidence: "high",
      category: "repository",
      title: "Competing package-manager lockfiles",
      message: `Project ${project.root} contains lockfiles for ${managers.join(" and ")}.`,
      location,
      evidence,
      impact: "Competing lockfiles can resolve different dependency graphs across tools and environments.",
      remediationConstraints: [
        "Retain exactly one package-manager lockfile for this project boundary.",
      ],
      remediation: "Keep the lockfile for the package manager this project uses and remove stale competing lockfiles.",
      verification: {
        command: "codebase-doctor audit . --format json",
        expected: "This fingerprint is absent and applicable repository audit coverage is completed.",
      },
      fingerprint: createFingerprint({
        doctorId: "project",
        ruleId: "repository/conflicting-lockfiles",
        location,
        identity: `${project.root}:${managers.join(",")}`,
      }),
    });
  }

  return findings;
}
