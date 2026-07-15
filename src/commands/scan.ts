import { Command } from "commander";
import { displayCommand } from "../execution/command-plan.js";
import { classifyScanExit } from "../core/normalize.js";
import { scanCodebase } from "../core/scan.js";
import type { FindingThreshold } from "../core/summary.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderTextReport } from "../reporters/text.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const THRESHOLDS = new Set<FindingThreshold>([
  "info",
  "low",
  "medium",
  "high",
  "critical",
  "none",
]);

interface ScanCommandOptions {
  runChecks: boolean;
  json: boolean;
  timeout: string;
  failOn: string;
}

function parseTimeout(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid timeout "${value}": expected an integer.`);
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout "${value}": expected 1-${MAX_TIMEOUT_MS} ms.`);
  }
  return timeoutMs;
}

function parseThreshold(value: string): FindingThreshold {
  if (!THRESHOLDS.has(value as FindingThreshold)) {
    throw new Error(`Invalid fail-on severity "${value}".`);
  }
  return value as FindingThreshold;
}

async function executeScan(path: string, options: ScanCommandOptions): Promise<void> {
  try {
    const timeoutMs = parseTimeout(options.timeout);
    const failOn = parseThreshold(options.failOn);
    const request = {
      root: path,
      runChecks: options.runChecks,
      format: options.json ? "json" : "text",
      timeoutMs,
      failOn,
    } as const;
    const result = await scanCodebase(
      request,
      {},
      options.json
        ? {}
        : {
            onCommandPlan: (plan) => {
              process.stdout.write(`Planned command: ${displayCommand(plan)}\n`);
            },
          },
    );
    const report = options.json
      ? renderJsonReport(result)
      : renderTextReport(result, {
          color: true,
          isTTY: process.stdout.isTTY === true,
          noColor: process.env.NO_COLOR !== undefined,
        });
    process.stdout.write(report);
    process.exitCode = classifyScanExit(result, failOn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codebase-doctor: ${message}\n`);
    process.exitCode = 2;
  }
}

export function createScanCommand(): Command {
  return new Command("scan")
    .description("Inspect a repository and report evidence-backed findings.")
    .argument("[path]", "repository path", ".")
    .option("--run-checks", "permit execution of detected validation commands", false)
    .option("--json", "emit machine-readable JSON", false)
    .option("--timeout <ms>", "per-command timeout in milliseconds", String(DEFAULT_TIMEOUT_MS))
    .option(
      "--fail-on <severity>",
      "failure threshold: info, low, medium, high, critical, or none",
      "high",
    )
    .action(executeScan);
}
