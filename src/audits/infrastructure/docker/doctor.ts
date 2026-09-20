import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";

const DOCTOR_ID = "infrastructure/docker";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

const REMOTE_ADD_PATTERN = /^(?:https?:\/\/|git@)/iu;
const PIPE_TO_SHELL_PATTERN =
  /(?:^|[;&|]\s*|\s)(?:sudo\s+)?(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:\/bin\/)?(?:ba|z|da|k)?sh\b/iu;
const WORLD_WRITABLE_PATTERN = /\bchmod\b[^;&|]*\b(?:777|a\+?rwx)\b/iu;

export interface DockerDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindings?: number;
}

interface Instruction {
  readonly keyword: string;
  readonly args: string;
  readonly line: number;
}

export function isDockerfilePath(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return basename === "dockerfile" || basename.endsWith(".dockerfile");
}

function logicalInstructions(content: string): Instruction[] {
  const instructions: Instruction[] = [];
  const rawLines = content.split(/\r?\n/u);
  let index = 0;
  while (index < rawLines.length) {
    const startLine = index + 1;
    let combined = rawLines[index]!;
    while (combined.trimEnd().endsWith("\\") && index + 1 < rawLines.length) {
      combined = `${combined.trimEnd().slice(0, -1)} ${rawLines[index + 1]!}`;
      index += 1;
    }
    index += 1;
    const trimmed = combined.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z]+)\s+(.*)$/su.exec(trimmed);
    if (match === null) continue;
    instructions.push({ keyword: match[1]!.toUpperCase(), args: match[2]!.trim(), line: startLine });
  }
  return instructions;
}

function finding(
  ruleId: string,
  severity: Finding["severity"],
  path: string,
  line: number,
  title: string,
  message: string,
  detail: string,
  identity: string,
  impact: string,
  remediation: string,
  changed: boolean,
): Finding {
  const location = { path, line };
  return {
    ruleId: `${DOCTOR_ID}/${ruleId}`,
    doctorId: DOCTOR_ID,
    severity,
    confidence: "high",
    category: "infrastructure",
    title,
    message,
    location,
    evidence: [{ type: "file", path, detail }],
    impact,
    remediationConstraints: [
      "Keep the image buildable and reproducible for the project's deployment target.",
      "Codebase Doctor never builds, runs, or rewrites the image.",
    ],
    remediation,
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected: "The finding fingerprint is absent and infrastructure/docker coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${ruleId}`,
      location,
      identity,
    }),
  };
}

export interface DockerAnalysis {
  readonly instructionsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

/**
 * Deterministic, offline Dockerfile analysis. It never builds or runs an
 * image: it reads instructions only and reports unpinned base images, remote
 * ADD fetches, pipe-to-shell installs, world-writable chmod, and explicit root
 * users. Build-arg-driven instructions are skipped as limitations.
 */
export function analyzeDockerfile(path: string, content: string, changed: boolean): DockerAnalysis {
  const findings: Finding[] = [];
  const limitations: string[] = [];
  const instructions = logicalInstructions(content);
  const stages = new Set<string>();

  for (const instruction of instructions) {
    if (instruction.keyword === "FROM") {
      const parts = instruction.args.split(/\s+/u).filter((part) => part.length > 0);
      const image = parts[0];
      const aliasIndex = parts.findIndex((part) => part.toLowerCase() === "as");
      const alias = aliasIndex >= 0 ? parts[aliasIndex + 1] : undefined;
      if (alias !== undefined) stages.add(alias.toLowerCase());
      if (image === undefined) continue;
      if (image.includes("$")) {
        limitations.push(`${path}:${instruction.line}: base image uses a build argument; pinning was not evaluated.`);
        continue;
      }
      if (image.toLowerCase() === "scratch" || stages.has(image.toLowerCase())) continue;
      const digestPinned = image.includes("@sha256:");
      const tagIndex = image.lastIndexOf(":");
      const tag = tagIndex > image.lastIndexOf("/") ? image.slice(tagIndex + 1) : undefined;
      if (!digestPinned && (tag === undefined || tag.toLowerCase() === "latest")) {
        findings.push(finding(
          "unpinned-base-image",
          "medium",
          path,
          instruction.line,
          "Base image is not pinned to an immutable reference",
          `Base image ${image} has no version tag or uses latest, so builds can silently change.`,
          `FROM ${image}`,
          `unpinned-base:${image}`,
          "A mutable base image can introduce unreviewed changes into every build.",
          "Pin the base image to a specific version tag or digest and update it deliberately.",
          changed,
        ));
      }
      continue;
    }

    if (instruction.keyword === "ADD") {
      const parts = instruction.args.split(/\s+/u).filter((part) => part.length > 0 && !part.startsWith("--"));
      if (parts.some((part) => REMOTE_ADD_PATTERN.test(part))) {
        findings.push(finding(
          "remote-add",
          "medium",
          path,
          instruction.line,
          "Remote ADD fetches content without checksum verification",
          "ADD retrieves a remote URL during the build without integrity verification.",
          "ADD with a remote URL",
          "remote-add",
          "Remote content fetched at build time can change or be tampered with between builds.",
          "Use COPY for local content, or fetch and verify a checksum explicitly in a RUN step.",
          changed,
        ));
      }
      continue;
    }

    if (instruction.keyword === "RUN") {
      if (PIPE_TO_SHELL_PATTERN.test(instruction.args)) {
        findings.push(finding(
          "pipe-to-shell",
          "high",
          path,
          instruction.line,
          "Build downloads and executes a remote script",
          "A RUN instruction pipes curl or wget output directly into a shell.",
          "RUN pipes remote content into a shell",
          "pipe-to-shell",
          "Executing a remote script during the build runs unreviewed code with build privileges.",
          "Download the installer, verify a checksum or signature, then execute the reviewed file.",
          changed,
        ));
      }
      if (WORLD_WRITABLE_PATTERN.test(instruction.args)) {
        findings.push(finding(
          "world-writable",
          "medium",
          path,
          instruction.line,
          "Build makes files world-writable",
          "A RUN instruction applies world-writable permissions inside the image.",
          "chmod 777 or a+rwx in RUN",
          "world-writable",
          "World-writable files inside the image weaken isolation for every process in the container.",
          "Grant only the permissions the application needs.",
          changed,
        ));
      }
      continue;
    }

    if (instruction.keyword === "USER") {
      const user = instruction.args.trim().split(/\s+/u)[0] ?? "";
      if (/^(?:root|0)(?::0)?$/iu.test(user)) {
        findings.push(finding(
          "root-user",
          "medium",
          path,
          instruction.line,
          "Container is configured to run as root",
          "A USER instruction selects root, so container processes run with root privileges.",
          "USER root",
          "root-user",
          "Root processes inside the container have more authority than the workload needs.",
          "Create a non-root user and select it with USER before the entrypoint.",
          changed,
        ));
      }
    }
  }

  return {
    instructionsExamined: instructions.length,
    findings: sortFindings(findings),
    limitations: [...new Set(limitations)].sort(),
  };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  instructionsExamined: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: instructionsExamined,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createDockerDoctor(options: DockerDoctorOptions = {}): Doctor {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const readSelectedFile = options.readFile ?? readFile;

  return {
    id: DOCTOR_ID,
    version: "0.1.0",
    capabilities: ["filesystem:read"],
    supports: () => true,
    async diagnose({ snapshot }): Promise<DoctorResult> {
      const startedAt = Date.now();
      const candidates = snapshot.files
        .filter((file) => file.kind === "file" && isDockerfilePath(file.path))
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
      const findings: Finding[] = [];
      let filesExamined = 0;
      let instructionsExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(`Docker audit finding limit of ${maxFindings} was reached; remaining Dockerfiles were not reported.`);
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte Docker audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(`Docker audit total content limit of ${maxTotalBytes} bytes was reached; remaining Dockerfiles were not examined.`);
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
        } catch {
          limitations.push(`${path}: Dockerfile could not be read.`);
          continue;
        }
        totalBytes += bytes.byteLength;
        filesExamined += 1;
        const analysis = analyzeDockerfile(path, Buffer.from(bytes).toString("utf8"), snapshot.auditScope.mode === "changed");
        instructionsExamined += analysis.instructionsExamined;
        findings.push(...analysis.findings);
        limitations.push(...analysis.limitations);
      }

      return {
        status: "completed",
        findings: sortFindings(findings).slice(0, maxFindings),
        coverage: [coverage(
          limitations.length > 0 ? "partial" : "completed",
          snapshot.auditScope.mode,
          filesExamined,
          instructionsExamined,
          Math.min(findings.length, maxFindings),
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
