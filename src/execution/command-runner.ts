import { spawn } from "node:child_process";
import type {
  CommandPlan,
  CommandRunResult,
  CommandRunnerOptions,
} from "./types.js";

export const MAX_OUTPUT_BYTES_PER_STREAM = 32 * 1024;
const FORCE_KILL_DELAY_MS = 250;

const INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export function buildCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  return environment;
}

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function append(capture: Capture, chunk: Buffer | string): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_OUTPUT_BYTES_PER_STREAM - capture.bytes;
  if (remaining > 0) {
    const kept = buffer.subarray(0, remaining);
    capture.chunks.push(kept);
    capture.bytes += kept.length;
  }
  if (buffer.length > remaining) capture.truncated = true;
}

function output(capture: Capture): string {
  return Buffer.concat(capture.chunks, capture.bytes).toString("utf8");
}

/**
 * Runs an approved argument-array plan without a shell. Approved child commands still
 * inherit host networking in v0.1; this runner does not provide network isolation.
 */
export function runCommand(
  plan: CommandPlan,
  options: CommandRunnerOptions = {},
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout: Capture = { chunks: [], bytes: 0, truncated: false };
    const stderr: Capture = { chunks: [], bytes: 0, truncated: false };
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(plan.executable, [...plan.args], {
      shell: false,
      cwd: plan.cwd,
      env: buildCommandEnvironment(options.sourceEnvironment),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    }, plan.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));

    function finish(result: CommandRunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolve(result);
    }

    child.once("error", (error) => {
      finish({
        status: "failed-to-start",
        error: error.message,
        stdout: output(stdout),
        stderr: output(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once("close", (exitCode, signal) => {
      const common = {
        stdout: output(stdout),
        stderr: output(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
      };
      if (timedOut) {
        finish({ status: "timed-out", exitCode, signal, ...common });
      } else {
        finish({ status: "completed", exitCode: exitCode ?? 1, signal, ...common });
      }
    });
  });
}
