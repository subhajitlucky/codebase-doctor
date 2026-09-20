import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AuditCoverage, Doctor, DoctorResult } from "../../../core/doctor.js";
import { createFingerprint, sortFindings, type Finding } from "../../../core/findings.js";

const DOCTOR_ID = "infrastructure/github-actions";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000_000;
const DEFAULT_MAX_FINDINGS = 200;

const FULL_COMMIT = /^[0-9a-f]{40}$/iu;
const VERSION_TAG = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const MUTABLE_REF = /^(?:main|master|head|latest|develop|dev)$/iu;
const INJECTION_PATTERN =
  /\$\{\{[^}]*\b(?:github\.(?:head_ref|event\.(?:pull_request|issue|comment|review|review_comment|discussion|workflow_run)\.(?:title|body|head\.ref|head\.label|head_branch)))[^}]*\}\}/u;

export interface GitHubActionsDoctorOptions {
  readonly readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFindings?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkflowPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith(".github/workflows/") && (lower.endsWith(".yml") || lower.endsWith(".yaml"));
}

function eventNames(value: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof value === "string") names.add(value);
  else if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === "string") names.add(entry);
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) names.add(key);
  }
  return names;
}

function finding(
  ruleId: string,
  severity: Finding["severity"],
  path: string,
  title: string,
  message: string,
  detail: string,
  identity: string,
  impact: string,
  remediation: string,
  changed: boolean,
): Finding {
  const location = { path };
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
      "Keep the workflow valid for GitHub Actions.",
      "Codebase Doctor never runs, dispatches, or rewrites workflows.",
    ],
    remediation,
    verification: {
      command: changed
        ? "codebase-doctor audit . --changed --format json"
        : "codebase-doctor audit . --format json",
      expected:
        "The finding fingerprint is absent and infrastructure/github-actions coverage completed for the same scope.",
    },
    fingerprint: createFingerprint({
      doctorId: DOCTOR_ID,
      ruleId: `${DOCTOR_ID}/${ruleId}`,
      location,
      identity,
    }),
  };
}

export interface WorkflowAnalysis {
  readonly stepsExamined: number;
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

/**
 * Deterministic, offline GitHub Actions analysis: script injection through
 * attacker-controlled expressions in run steps, pull_request_target checkout
 * of PR head code, write-all permissions, and actions pinned to mutable refs.
 * Workflows are never executed or dispatched.
 */
export function analyzeWorkflow(path: string, content: string, changed: boolean): WorkflowAnalysis {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return { stepsExamined: 0, findings: [], limitations: [`${path}: workflow is not valid YAML.`] };
  }
  if (!isObject(parsed)) {
    return { stepsExamined: 0, findings: [], limitations: [`${path}: workflow must be a YAML mapping.`] };
  }
  const jobs = parsed["jobs"];
  if (!isObject(jobs)) {
    return { stepsExamined: 0, findings: [], limitations: [`${path}: workflow has no jobs mapping.`] };
  }

  const findings: Finding[] = [];
  const limitations: string[] = [];
  const events = eventNames(parsed["on"]);
  let stepsExamined = 0;

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      limitations.push(`${path}: job ${jobId} is not a mapping.`);
      continue;
    }
    if (job["permissions"] === "write-all") {
      findings.push(finding(
        "write-all-permissions",
        "medium",
        path,
        "Workflow job grants write-all permissions",
        `Job ${jobId} requests write-all token permissions instead of the scopes it needs.`,
        `jobs.${jobId}.permissions = write-all`,
        `job:${jobId}:write-all`,
        "A workflow with write-all permissions can modify the repository if any step is compromised.",
        "Grant only the permissions the job needs, preferably read-only at the workflow level.",
        changed,
      ));
    }

    const steps = job["steps"];
    if (!Array.isArray(steps)) continue;
    let checkoutPrHead = false;

    steps.forEach((step, index) => {
      if (!isObject(step)) return;
      stepsExamined += 1;
      const identityBase = `job:${jobId}:step:${index}`;

      const uses = step["uses"];
      if (typeof uses === "string" && !uses.startsWith("./") && !uses.startsWith("docker://")) {
        const separator = uses.lastIndexOf("@");
        const ref = separator > 0 ? uses.slice(separator + 1) : undefined;
        const target = separator > 0 ? uses.slice(0, separator) : uses;
        if (
          ref !== undefined &&
          !FULL_COMMIT.test(ref) &&
          !VERSION_TAG.test(ref) &&
          (MUTABLE_REF.test(ref) || ref.includes("/"))
        ) {
          findings.push(finding(
            "unpinned-action",
            "medium",
            path,
            "Action is pinned to a mutable reference",
            `Action ${target} is pinned to the mutable ref ${ref}, so the executed code can change without a workflow edit.`,
            `uses: ${target}@${ref}`,
            `${identityBase}:unpinned`,
            "A mutable action ref can execute different code than the reviewed workflow revision.",
            "Pin the action to a full commit SHA (or a version tag managed by the action's release process).",
            changed,
          ));
        }
      }

      const withBlock = step["with"];
      if (
        isObject(withBlock) &&
        typeof withBlock["ref"] === "string" &&
        typeof uses === "string" &&
        uses.split("@")[0] === "actions/checkout"
      ) {
        if (/github\.event\.pull_request\.head|github\.head_ref/u.test(withBlock["ref"])) {
          checkoutPrHead = true;
        }
      }

      const run = step["run"];
      if (typeof run === "string" && INJECTION_PATTERN.test(run)) {
        findings.push(finding(
          "script-injection",
          "high",
          path,
          "Workflow run step interpolates attacker-controlled context",
          `Step ${index} of job ${jobId} interpolates an attacker-controlled expression directly into a shell command.`,
          `run step interpolates a github.event or github.head_ref expression`,
          `${identityBase}:injection`,
          "Interpolated event data can break out of the intended command and execute arbitrary shell code with the job token.",
          "Pass the value through an env variable (or an action input) and quote it in the shell command.",
          changed,
        ));
      }
    });

    if (events.has("pull_request_target") && checkoutPrHead) {
      findings.push(finding(
        "pull-request-target-checkout",
        "high",
        path,
        "pull_request_target checks out untrusted PR code",
        `Job ${jobId} runs on pull_request_target and checks out the pull request head, giving untrusted code repository secrets.`,
        `jobs.${jobId}: pull_request_target with actions/checkout ref at the PR head`,
        `job:${jobId}:prt-checkout`,
        "Untrusted pull request code can execute with the base repository's secrets and token permissions.",
        "Avoid checking out PR head code on pull_request_target; use pull_request with least permissions and review requirements instead.",
        changed,
      ));
    }
  }

  return {
    stepsExamined,
    findings: sortFindings(findings),
    limitations: [...new Set(limitations)].sort(),
  };
}

function coverage(
  status: AuditCoverage["status"],
  scope: string,
  filesExamined: number,
  stepsExamined: number,
  findingsReported: number,
  limitations: readonly string[],
): AuditCoverage {
  return {
    moduleId: DOCTOR_ID,
    status,
    scope,
    filesExamined,
    statementsExamined: stepsExamined,
    statementsRecognized: findingsReported,
    limitations: [...new Set(limitations)].sort(),
  };
}

export function createGitHubActionsDoctor(options: GitHubActionsDoctorOptions = {}): Doctor {
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
        .filter((file) => file.kind === "file" && isWorkflowPath(file.path))
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
      let stepsExamined = 0;
      let totalBytes = 0;
      for (const path of candidates) {
        if (findings.length >= maxFindings) {
          limitations.push(`GitHub Actions audit finding limit of ${maxFindings} was reached; remaining workflows were not reported.`);
          break;
        }
        const file = snapshot.files.find((entry) => entry.path === path);
        const size = file?.size ?? 0;
        if (size > maxFileBytes) {
          limitations.push(`${path}: file exceeds the ${maxFileBytes}-byte workflow audit size limit.`);
          continue;
        }
        if (totalBytes + size > maxTotalBytes) {
          limitations.push(`GitHub Actions audit total content limit of ${maxTotalBytes} bytes was reached; remaining workflows were not examined.`);
          break;
        }
        let bytes: Uint8Array;
        try {
          bytes = await readSelectedFile(join(snapshot.root, ...path.split("/")));
        } catch {
          limitations.push(`${path}: workflow could not be read.`);
          continue;
        }
        totalBytes += bytes.byteLength;
        filesExamined += 1;
        const analysis = analyzeWorkflow(path, Buffer.from(bytes).toString("utf8"), snapshot.auditScope.mode === "changed");
        stepsExamined += analysis.stepsExamined;
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
          stepsExamined,
          Math.min(findings.length, maxFindings),
          limitations,
        )],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
