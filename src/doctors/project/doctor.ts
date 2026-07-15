import type { Doctor } from "../../core/doctor.js";
import { sortFindings } from "../../core/findings.js";
import { findConflictingLockfiles } from "./rules/conflicting-lockfiles.js";
import { findInvalidManifests } from "./rules/invalid-manifest.js";
import { findMissingWorkspaces } from "./rules/missing-workspace.js";
import { findTestVisibility } from "./rules/test-visibility.js";

export const projectDoctor: Doctor = {
  id: "project",
  version: "0.1.0",
  capabilities: ["filesystem:read"],
  supports: () => true,
  diagnose: async ({ snapshot }) => {
    const startedAt = Date.now();
    const findings = sortFindings([
      ...findConflictingLockfiles(snapshot),
      ...findInvalidManifests(snapshot),
      ...findMissingWorkspaces(snapshot),
      ...findTestVisibility(snapshot),
    ]);

    return {
      status: "completed",
      findings,
      durationMs: Date.now() - startedAt,
    };
  },
};
