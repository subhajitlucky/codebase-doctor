import { Command } from "commander";
import { loadCodebaseConfig, validateExcludePattern } from "../config/config.js";
import { loadBaseline, withBaselineComparison } from "../core/baseline.js";
import { classifyScanExit } from "../core/normalize.js";
import { scanCodebase, type ScanRequest } from "../core/scan.js";
import type { FindingThreshold } from "../core/summary.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderSarifReport } from "../reporters/sarif.js";
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

export interface RepositoryCommandOptions {
  runChecks: boolean;
  changed: boolean;
  base?: string;
  json: boolean;
  format?: string;
  exclude: string[];
  baseline?: string;
  timeout: string;
  failOn: string;
}

type OutputFormat = "text" | "json" | "sarif";
const OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "sarif"]);

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

function parseFormat(options: RepositoryCommandOptions): OutputFormat {
  if (options.format !== undefined && !OUTPUT_FORMATS.has(options.format as OutputFormat)) {
    throw new Error(`Invalid output format "${options.format}".`);
  }
  if (options.json && options.format !== undefined && options.format !== "json") {
    throw new Error("The --json and --format options conflict.");
  }
  return options.json ? "json" : (options.format as OutputFormat | undefined) ?? "text";
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function executeScan(
  path: string,
  options: RepositoryCommandOptions,
  requestOptions: () => Partial<ScanRequest> = () => ({}),
): Promise<void> {
  try {
    if (options.base !== undefined && options.changed !== true) {
      throw new Error("The --base option requires --changed.");
    }
    if (options.changed && options.base !== undefined && options.base.trim().length === 0) {
      throw new Error("The --base option must not be empty.");
    }
    const timeoutMs = parseTimeout(options.timeout);
    const failOn = parseThreshold(options.failOn);
    const format = parseFormat(options);
    const config = await loadCodebaseConfig(path);
    const exclude = [...config.exclude, ...options.exclude.map(validateExcludePattern)];
    const baseline = options.baseline === undefined
      ? undefined
      : await loadBaseline(options.baseline);
    const request = {
      root: path,
      runChecks: options.runChecks,
      format,
      timeoutMs,
      failOn,
      exclude,
      ...requestOptions(),
      changed: options.changed,
      ...(options.base === undefined ? {} : { baseRef: options.base }),
    } as const;
    const scanned = await scanCodebase(request);
    const result = baseline === undefined
      ? scanned
      : withBaselineComparison(scanned, baseline.findings);
    const report = format === "json"
      ? renderJsonReport(result)
      : format === "sarif" ? renderSarifReport(result) : renderTextReport(result, {
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

export function configureRepositoryCommand<Options extends RepositoryCommandOptions>(
  command: Command,
  requestOptions: (options: Options) => Partial<ScanRequest> = () => ({}),
): Command {
  return command
    .argument("[path]", "repository path", ".")
    .option("--run-checks", "permit execution of detected validation commands", false)
    .option(
      "--changed",
      "audit staged, unstaged, untracked, and branch changes",
      false,
    )
    .option("--base <ref>", "compare changed scope from the merge base with this ref")
    .option("--json", "emit machine-readable JSON", false)
    .option("--format <format>", "output format: text, json, or sarif")
    .option("--exclude <glob>", "exclude a repository-relative path glob", collect, [])
    .option("--baseline <path>", "compare findings with a prior JSON report")
    .option("--timeout <ms>", "per-command timeout in milliseconds", String(DEFAULT_TIMEOUT_MS))
    .option(
      "--fail-on <severity>",
      "failure threshold: info, low, medium, high, critical, or none",
      "high",
    )
    .action((path: string, options: Options) =>
      executeScan(path, options, () => requestOptions(options))
    );
}

export function createScanCommand(): Command {
  return configureRepositoryCommand(
    new Command("scan")
      .description("Inspect a repository and report evidence-backed findings."),
  );
}
