import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";
import type { ChangedPath } from "../../../scope/types.js";
import { analyzeSecrets } from "../secrets/analyzer.js";
import type { SecretFindingFamily } from "../secrets/types.js";
import { scanGitHistory, type HistoryMatch, type HistoryScanResult } from "./history.js";

const DOCTOR_ID = "security/secrets-history";
const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_MAX_PATCH_BYTES = 20_000_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

const TITLE_BY_FAMILY: Record<SecretFindingFamily, string> = {
  "private-key": "Private key material is reachable in Git history",
  "provider-token": "Provider credential is reachable in Git history",
  "aws-credentials": "AWS credential pair is reachable in Git history",
  "credential-url": "URL with credentials is reachable in Git history",
  "sensitive-assignment": "Sensitive assignment may expose a credential in Git history",
};

export interface SecretsHistoryDoctorOptions {
  readonly scanner?: (root: string, options: { maxCommits?: number; maxPatchBytes?: number; paths?: readonly string[] }) => Promise<HistoryScanResult>;
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxCommits?: number;
  readonly maxPatchBytes?: number;
}

function findingFor(match: HistoryMatch): Finding {
  const shortCommit = match.commit.slice(0, 7);
  const location = { path: match.path };
  return {
    ruleId: `${DOCTOR_ID}/${match.family}`,
    doctorId: DOCTOR_ID,
    severity: match.severity,
    confidence: match.confidence,
    category: "security",
    title: TITLE_BY_FAMILY[match.family],
    message: `A credential-shaped value added in commit ${shortCommit} is still reachable in Git history. The value was withheld.`,
    location,
    evidence: [
      {
        type: "file",
        path: match.path,
        detail: `commit ${shortCommit}; detector ${match.detectorId}; ${match.occurrences} added-line occurrence(s); value withheld.`,
      },
    ],
    impact:
      "A credential remains reachable to anyone with repository history access even after it is deleted from the working tree.",
    remediationConstraints: [
      "Rotate or revoke the credential first; history rewriting cannot un-expose it.",
      "Use the repository's authorized history-rewriting workflow outside Codebase Doctor.",
      "Coordinate with collaborators before rewriting shared history.",
    ],
    remediation: `Have an authorized human or external coding agent rotate or revoke the credential, remove it from history with an authorized tool, then rerun a full audit.`,
    verification: {
      command: "codebase-doctor audit . --format json",
      expected:
        "The finding fingerprint is absent and security/secrets-history coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${match.family}`,
      location,
      identity: `${match.detectorId}:${match.path}`,
    }),
  };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  addedLinesExamined: number,
  matches: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: addedLinesExamined,
    statementsRecognized: matches,
    limitations: [...new Set(limitations)].sort(),
  };
}

/**
 * Repository-relative paths worth scanning in changed mode: each changed
 * path plus rename/copy sources. Deleted paths stay in scope because a
 * credential deleted from the working tree is exactly what history covers.
 */
export function changedHistoryPaths(changes: readonly ChangedPath[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.previousPath !== undefined) paths.add(change.previousPath);
  }
  return [...paths].sort();
}

/**
 * Read-only, offline scan of recent Git history for credentials that were
 * deleted from the working tree but remain reachable in commits. Changed
 * audits scan history for the changed paths instead of reporting
 * not-selected, so a PR that deletes a leaked file cannot review clean.
 */
export function createSecretsHistoryDoctor(options: SecretsHistoryDoctorOptions = {}): Doctor {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const scanner = options.scanner ?? scanGitHistory;
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const changed = snapshot.auditScope.mode === "changed";
      const paths = changed ? changedHistoryPaths(snapshot.auditScope.changes) : undefined;
      const scope = changed ? "changed" : "full";

      if (paths !== undefined && paths.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: [
            coverage("completed", scope, 0, 0, 0, [
              "No changed paths were selected; history scanning had nothing to check.",
            ]),
          ],
          durationMs: Date.now() - startedAt,
        };
      }

      const scan = await scanner(snapshot.root, {
        maxCommits,
        maxPatchBytes,
        ...(paths === undefined ? {} : { paths }),
      });
      const currentLimitations: string[] = [];
      const stillCurrent = new Set<string>();
      for (const match of scan.matches) {
        const identity = `${match.detectorId}\u0000${match.path}`;
        const file = snapshot.files.find(
          (entry) => entry.kind === "file" && entry.path === match.path,
        );
        if (file === undefined) continue;
        if (file.size > DEFAULT_MAX_FILE_BYTES) {
          currentLimitations.push(
            `${match.path}: current content exceeds the ${DEFAULT_MAX_FILE_BYTES}-byte limit, so history findings for it were kept without current-content verification.`,
          );
          continue;
        }
        let content: string;
        try {
          const bytes = await readSelectedFile(join(snapshot.root, ...match.path.split("/")));
          if (bytes.includes(0)) continue;
          content = Buffer.from(bytes).toString("utf8");
        } catch {
          currentLimitations.push(
            `${match.path}: current content could not be read, so history findings for it were kept without current-content verification.`,
          );
          continue;
        }
        if (analyzeSecrets(content).some((current) => current.detectorId === match.detectorId)) {
          stillCurrent.add(identity);
        }
      }
      const findings = scan.matches
        .filter((match) => !stillCurrent.has(`${match.detectorId}\u0000${match.path}`))
        .map(findingFor);

      return {
        status: "completed",
        findings: sortFindings(findings),
        coverage: [
          coverage(
            scan.status === "partial" ? "partial" : "completed",
            scope,
            scan.filesExamined,
            scan.addedLinesExamined,
            findings.length,
            [
              paths === undefined
                ? `History scan examined up to ${maxCommits} commits across all branches.`
                : `History scan examined up to ${maxCommits} commits for ${paths.length} changed path(s).`,
              ...scan.limitations,
              ...currentLimitations,
            ],
          ),
        ],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
