import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import {
  createFingerprint,
  sortFindings,
  type Finding,
} from "../../../core/findings.js";
import { analyzeSecrets } from "./analyzer.js";
import { selectSecretAuditFiles } from "./selection.js";
import type { SecretFindingFamily, SecretMatch } from "./types.js";

const DOCTOR_ID = "security/secrets";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 100_000_000;
const DEFAULT_MAX_FINDINGS_PER_FILE = 100;
const DEFAULT_MAX_FINDINGS = 1_000;

export interface SecretsDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindingsPerFile?: number;
  readonly maxFindings?: number;
}

const TITLE_BY_FAMILY: Record<SecretFindingFamily, string> = {
  "private-key": "Private key material is repository-shareable",
  "provider-token": "Provider credential is repository-shareable",
  "aws-credentials": "AWS credential pair is repository-shareable",
  "credential-url": "URL contains repository-shareable credentials",
  "sensitive-assignment": "Sensitive assignment may contain a credential",
};

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function findingFor(path: string, match: SecretMatch, changed: boolean): Finding {
  const location = { path, line: match.line, column: match.column };
  const rerun = changed
    ? "codebase-doctor audit . --changed --json"
    : "codebase-doctor audit . --json";
  return {
    ruleId: `security/secrets/${match.family}`,
    doctorId: DOCTOR_ID,
    severity: match.severity,
    confidence: match.confidence,
    category: "security",
    title: TITLE_BY_FAMILY[match.family],
    message: "A credential-shaped value was found in repository-shareable content. The value was withheld.",
    location,
    evidence: [{
      type: "file",
      path,
      detail: `A ${match.detectorId} credential pattern matched; the value was withheld.`,
    }],
    impact: "A shared credential can permit unauthorized access to external systems or protected data.",
    remediationConstraints: [
      "Remove the credential from repository-shareable content without placing it in another tracked file.",
      "Rotate or revoke the exposed credential outside Codebase Doctor.",
      "Preserve runtime access through an ignored local environment file or an approved secret store.",
    ],
    remediation: "Have an authorized human or external coding agent remove the value and rotate it, then rerun the audit.",
    verification: {
      command: rerun,
      expected: "The finding fingerprint is absent and security/secrets coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `security/secrets/${match.family}`,
      location,
      identity: `${match.detectorId}:${match.assignmentName?.toLowerCase() ?? ""}`,
    }),
  };
}

function coverage(
  scope: "full" | "changed",
  filesExamined: number,
  linesExamined: number,
  matches: number,
  limitations: readonly string[],
): AuditCoverage {
  const status = limitations.length > 0
    ? "partial"
    : filesExamined === 0 ? "not-applicable" : "completed";
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: linesExamined,
    statementsRecognized: matches,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createSecretsDoctor(options: SecretsDoctorOptions = {}): Doctor {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFindingsPerFile = options.maxFindingsPerFile ?? DEFAULT_MAX_FINDINGS_PER_FILE;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error("Secrets audit file size limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new Error("Secrets audit total content limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxFindingsPerFile) || maxFindingsPerFile < 1) {
    throw new Error("Secrets audit per-file finding limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1) {
    throw new Error("Secrets audit finding limit must be a positive integer.");
  }
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const selection = selectSecretAuditFiles(snapshot);
      const limitations = [...selection.limitations];
      const findings: Finding[] = [];
      let filesExamined = 0;
      let linesExamined = 0;
      let matchesRecognized = 0;
      let totalBytes = 0;

      for (const file of selection.files) {
        if (findings.length >= maxFindings) {
          limitations.push(
            `Secrets audit finding limit of ${maxFindings} was reached; additional matches and remaining selected files were not reported.`,
          );
          break;
        }
        if (file.size > maxFileBytes) {
          limitations.push(
            `${file.path}: file exceeds the ${maxFileBytes}-byte secrets audit size limit.`,
          );
          continue;
        }
        if (totalBytes + file.size > maxTotalBytes) {
          limitations.push(
            `${file.path}: total secrets audit content limit of ${maxTotalBytes} bytes was reached; remaining selected files were not examined.`,
          );
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...file.path.split("/")));
        } catch {
          limitations.push(`${file.path}: unable to read selected file for secrets audit.`);
          continue;
        }
        if (bytes.byteLength > maxFileBytes) {
          limitations.push(
            `${file.path}: file exceeds the ${maxFileBytes}-byte secrets audit size limit.`,
          );
          continue;
        }
        if (totalBytes + bytes.byteLength > maxTotalBytes) {
          limitations.push(
            `${file.path}: total secrets audit content limit of ${maxTotalBytes} bytes was reached; remaining selected files were not examined.`,
          );
          break;
        }
        totalBytes += bytes.byteLength;
        if (bytes.includes(0)) continue;

        const content = Buffer.from(bytes).toString("utf8");
        const detectedMatches = analyzeSecrets(content);
        const fileMatches = detectedMatches.slice(0, maxFindingsPerFile);
        if (detectedMatches.length > maxFindingsPerFile) {
          limitations.push(
            `${file.path}: secrets finding limit of ${maxFindingsPerFile} was reached; additional matches were withheld.`,
          );
        }
        const remainingFindings = maxFindings - findings.length;
        const matches = fileMatches.slice(0, remainingFindings);
        const auditLimitReached = fileMatches.length > remainingFindings;
        if (auditLimitReached) {
          limitations.push(
            `Secrets audit finding limit of ${maxFindings} was reached; additional matches and remaining selected files were not reported.`,
          );
        }
        filesExamined += 1;
        linesExamined += lineCount(content);
        matchesRecognized += matches.length;
        findings.push(...matches.map((match) =>
          findingFor(file.path, match, snapshot.auditScope.mode === "changed")
        ));
        if (auditLimitReached) break;
      }

      return {
        status: "completed",
        findings: sortFindings(findings),
        coverage: [coverage(
          selection.scope,
          filesExamined,
          linesExamined,
          matchesRecognized,
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
