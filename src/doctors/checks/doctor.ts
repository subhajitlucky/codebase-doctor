import type {
  CheckRunRecord,
  Doctor,
  DoctorContext,
  DoctorResult,
  OperationalError,
} from "../../core/doctor.js";
import { createFingerprint, sortFindings, type Evidence, type Finding } from "../../core/findings.js";
import { displayCommand } from "../../execution/command-plan.js";
import { runCommand } from "../../execution/command-runner.js";
import { redactText } from "../../execution/redaction.js";
import type {
  CommandPlan,
  CommandRunner,
  CommandRunResult,
} from "../../execution/types.js";
import { planJavaScriptChecks } from "./javascript.js";
import { planPythonChecks } from "./python.js";

export interface CheckDoctorResult extends DoctorResult {
  checkRuns: readonly CheckRunRecord[];
}

export type { CheckRunRecord } from "../../core/doctor.js";

export interface CheckDoctor extends Omit<Doctor, "diagnose"> {
  diagnose(context: DoctorContext): Promise<CheckDoctorResult>;
}

export interface CheckDoctorOptions {
  runner?: CommandRunner;
  timeoutMs?: number;
  redactionEnvironment?: NodeJS.ProcessEnv;
}

function outputEvidence(
  result: CommandRunResult,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const output = [result.stdout, result.stderr]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  return output.length === 0 ? undefined : redactText(output, environment);
}

function commandEvidence(
  plan: CommandPlan,
  result: Exclude<CommandRunResult, { status: "failed-to-start" }>,
  environment: NodeJS.ProcessEnv,
): Evidence {
  const output = outputEvidence(result, environment);
  return {
    type: "command",
    command: displayCommand(plan),
    exitCode: result.exitCode ?? -1,
    ...(output === undefined ? {} : { output }),
  };
}

function failedFinding(
  plan: CommandPlan,
  result: Extract<CommandRunResult, { status: "completed" }>,
  environment: NodeJS.ProcessEnv,
): Finding {
  return {
    ruleId: "checks/command-failed",
    doctorId: "checks",
    severity: "high",
    confidence: "high",
    category: "validation",
    title: `${plan.label} failed`,
    message: `${displayCommand(plan)} exited with code ${result.exitCode}.`,
    evidence: [commandEvidence(plan, result, environment)],
    remediation: "Review the command output, fix the reported validation failures, and run the configured check again.",
    fingerprint: createFingerprint({
      doctorId: "checks",
      ruleId: "checks/command-failed",
      identity: plan.id,
    }),
  };
}

function timeoutFinding(
  plan: CommandPlan,
  result: Extract<CommandRunResult, { status: "timed-out" }>,
  environment: NodeJS.ProcessEnv,
): Finding {
  return {
    ruleId: "checks/command-timeout",
    doctorId: "checks",
    severity: "medium",
    confidence: "high",
    category: "validation",
    title: `${plan.label} timed out`,
    message: `${displayCommand(plan)} exceeded its ${plan.timeoutMs} ms timeout.`,
    evidence: [commandEvidence(plan, result, environment)],
    remediation: "Investigate the hanging check or rerun with an explicitly larger timeout.",
    fingerprint: createFingerprint({
      doctorId: "checks",
      ruleId: "checks/command-timeout",
      identity: plan.id,
    }),
  };
}

function checkRecord(
  plan: CommandPlan,
  result: CommandRunResult,
): CheckRunRecord {
  const base = {
    planId: plan.id,
    projectId: plan.projectId,
    command: displayCommand(plan),
    durationMs: result.durationMs,
  };
  if (result.status === "failed-to-start") {
    return { ...base, status: "skipped", reason: result.error };
  }
  if (result.status === "timed-out") {
    return {
      ...base,
      status: "timed-out",
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    };
  }
  return {
    ...base,
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
  };
}

export function createCheckDoctor(options: CheckDoctorOptions = {}): CheckDoctor {
  const runner = options.runner ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const redactionEnvironment = options.redactionEnvironment ?? process.env;

  return {
    id: "checks",
    version: "0.1.0",
    capabilities: ["filesystem:read", "process:execute"],
    supports: async (snapshot) => snapshot.projects.some((project) =>
      project.executionSupport === "supported" &&
      (project.ecosystems.includes("node") || project.ecosystems.includes("python")),
    ),
    diagnose: async (context) => {
      if (!context.allowedCapabilities.has("process:execute")) {
        return {
          status: "skipped",
          findings: [],
          skipReason: "Check Doctor requires process:execute capability.",
          durationMs: 0,
          checkRuns: [],
        };
      }

      const startedAt = Date.now();
      const plans = [
        ...planJavaScriptChecks(context.snapshot, timeoutMs),
        ...planPythonChecks(context.snapshot, timeoutMs),
      ];
      const findings: Finding[] = [];
      const checkRuns: CheckRunRecord[] = [];
      let operationalError: OperationalError | undefined;

      for (const plan of plans) {
        let result: CommandRunResult;
        try {
          result = await runner(plan);
        } catch (error) {
          operationalError = {
            code: "command_runner_failed",
            message: error instanceof Error ? error.message : String(error),
          };
          break;
        }

        checkRuns.push(checkRecord(plan, result));
        if (result.status === "completed" && result.exitCode !== 0) {
          findings.push(failedFinding(plan, result, redactionEnvironment));
        } else if (result.status === "timed-out") {
          findings.push(timeoutFinding(plan, result, redactionEnvironment));
          operationalError ??= {
            code: "check_timeout",
            message: `${displayCommand(plan)} timed out.`,
          };
        }
      }

      return {
        status: operationalError === undefined ? "completed" : "failed",
        findings: sortFindings(findings),
        ...(operationalError === undefined ? {} : { error: operationalError }),
        durationMs: Date.now() - startedAt,
        checkRuns,
      };
    },
  };
}

export const checkDoctor = createCheckDoctor();
