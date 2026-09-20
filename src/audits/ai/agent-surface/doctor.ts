import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";
import {
  AGENT_SURFACE_DOCTOR_ID,
  analyzeMcpConfig,
  MCP_CONFIG_BASENAMES,
  type AgentSurfaceMatch,
} from "./mcp-config.js";
import {
  analyzeInstructionFlags,
  analyzePermissionConfig,
  isInstructionFile,
  permissionConfigKind,
} from "./permissions.js";
import { analyzeSkillFile } from "./skills.js";

const DOCTOR_ID = AGENT_SURFACE_DOCTOR_ID;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 50_000_000;
const DEFAULT_MAX_FILES = 200;

export interface AgentSurfaceDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function isMcpConfig(path: string): boolean {
  return MCP_CONFIG_BASENAMES.has(path.split("/").at(-1) ?? path);
}

function isSkillFile(path: string): boolean {
  return (path.split("/").at(-1) ?? path) === "SKILL.md";
}

function isAgentSurfaceCandidate(path: string): boolean {
  return isMcpConfig(path) ||
    isSkillFile(path) ||
    isInstructionFile(path) ||
    permissionConfigKind(path) !== undefined;
}

function findingFor(match: AgentSurfaceMatch, changed: boolean): Finding {
  const location = { path: match.path };
  return {
    ruleId: match.ruleId,
    doctorId: DOCTOR_ID,
    severity: match.severity,
    confidence: match.confidence,
    category: "ai",
    title: match.title,
    message: match.message,
    location,
    evidence: [match.evidence],
    impact: match.impact,
    remediationConstraints: [
      "Keep the agent configuration valid for the client that reads it.",
      "Rotate any credential that may already be exposed.",
      "Do not run the configured server to inspect it.",
    ],
    remediation: match.remediation,
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected:
        "The finding fingerprint is absent and ai/agent-surface coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: match.ruleId,
      location,
      identity: match.identity,
    }),
  };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  entriesExamined: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: entriesExamined,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

/**
 * Read-only, offline audit of the agent configuration surface: MCP client
 * configurations (unpinned package runners, shell commands, inline
 * credentials, broad filesystem grants), SKILL.md frontmatter and tool
 * grants, documented permission settings (bypass modes, unscoped allow rules,
 * hook commands), and permission-bypass flags that instruction or prompt files
 * present as commands. It never executes a configured command, never connects
 * to a server, and never prints a suspected credential value.
 */
export function createAgentSurfaceDoctor(options: AgentSurfaceDoctorOptions = {}): Doctor {
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    "Agent surface file size limit",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "Agent surface total content limit",
  );
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, "Agent surface file limit");
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const candidates = snapshot.files
        .filter((file) => file.kind === "file" && isAgentSurfaceCandidate(file.path))
        .map((file) => file.path)
        .sort();

      if (candidates.length === 0) {
        return {
          status: "completed",
          findings: [],
          coverage: [coverage("not-applicable", snapshot.auditScope.mode, 0, 0, 0, [])],
          durationMs: Date.now() - startedAt,
        };
      }

      const limitations: string[] = [];
      const matches: AgentSurfaceMatch[] = [];
      let filesExamined = 0;
      let entriesExamined = 0;
      let totalBytes = 0;
      let truncated = false;

      for (const path of candidates) {
        if (filesExamined >= maxFiles) {
          limitations.push(
            `Agent surface file limit of ${maxFiles} was reached; remaining configuration files were not examined.`,
          );
          break;
        }

        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte agent surface size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(
            `Agent surface total content limit of ${maxTotalBytes} bytes was reached; remaining files were not examined.`,
          );
          break;
        }

        let bytes: Uint8Array | undefined;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
        } catch {
          limitations.push(`${path}: unable to read selected agent configuration.`);
          continue;
        }
        totalBytes += bytes.byteLength;
        filesExamined += 1;

        const content = Buffer.from(bytes).toString("utf8");
        if (isMcpConfig(path)) {
          const analysis = analyzeMcpConfig(path, content);
          entriesExamined += analysis.servers;
          matches.push(...analysis.matches);
          limitations.push(...analysis.limitations);
        } else if (isSkillFile(path)) {
          const analysis = analyzeSkillFile(path, content);
          entriesExamined += 1;
          matches.push(...analysis.matches);
          limitations.push(...analysis.limitations);
          const flags = analyzeInstructionFlags(path, content);
          matches.push(...flags.matches);
        } else {
          const kind = permissionConfigKind(path);
          if (kind !== undefined) {
            const analysis = analyzePermissionConfig(path, kind, content);
            entriesExamined += analysis.entries;
            matches.push(...analysis.matches);
            limitations.push(...analysis.limitations);
          }
          if (isInstructionFile(path)) {
            entriesExamined += 1;
            matches.push(...analyzeInstructionFlags(path, content).matches);
          }
        }

        if (totalBytes >= maxTotalBytes && filesExamined < candidates.length) {
          truncated = true;
        }
      }

      const status = limitations.length > 0 || truncated ? "partial" : "completed";
      return {
        status: "completed",
        findings: sortFindings(matches.map((match) => findingFor(match, snapshot.auditScope.mode === "changed"))),
        coverage: [
          coverage(status, snapshot.auditScope.mode, filesExamined, entriesExamined, matches.length, limitations),
        ],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
