import { Command } from "commander";
import { loadCodebaseConfig, validateExcludePattern } from "../config/config.js";
import { loadBaseline, withBaselineComparison } from "../core/baseline.js";
import { classifyScanExit, type ScanResult } from "../core/normalize.js";
import { scanCodebase, type ScanRequest } from "../core/scan.js";
import type { FindingThreshold } from "../core/summary.js";
import { renderBriefReport } from "../reporters/brief.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderSarifReport } from "../reporters/sarif.js";
import { renderTextReport } from "../reporters/text.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_FINDINGS = 100;
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
  base?: string | true;
  json: boolean;
  format?: string;
  exclude: string[];
  baseline?: string;
  timeout: string;
  failOn: string;
  requireComplete: boolean;
  maxFindings: string;
}

type OutputFormat = "text" | "json" | "sarif" | "brief";
const OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "sarif", "brief"]);

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

function parseMaxFindings(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid max findings "${value}": expected a positive integer.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Invalid max findings "${value}": expected a positive integer.`);
  }
  return count;
}

async function executeScan(
  path: string,
  options: RepositoryCommandOptions,
  requestOptions: () => Partial<ScanRequest> = () => ({}),
): Promise<void> {
  try {
    const { result, format, failOn } = await runRepositoryScan(path, options, requestOptions);
    process.stdout.write(renderScanReport(result, format, options));
    process.exitCode = classifyScanExit(result, failOn, {
      requireComplete: options.requireComplete,
    });
    if (
      options.requireComplete &&
      process.exitCode === 2 &&
      result.domainCoverage.some((domain) => !domain.coverageComplete)
    ) {
      process.stderr.write(
        "codebase-doctor: audit coverage is incomplete and --require-complete was set; failing with exit code 2.\n",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codebase-doctor: ${message}\n`);
    process.exitCode = 2;
  }
}

export interface RepositoryScanOutcome {
  result: ScanResult;
  format: OutputFormat;
  failOn: FindingThreshold;
}

/**
 * Shared scan/audit execution: validation, configuration, optional baseline
 * comparison, and the audit itself. Commands own rendering and exit codes.
 */
export async function runRepositoryScan<Options extends RepositoryCommandOptions>(
  path: string,
  options: Options,
  requestOptions: () => Partial<ScanRequest> = () => ({}),
): Promise<RepositoryScanOutcome> {
  if (options.base !== undefined && options.changed !== true) {
    throw new Error("The --base option requires --changed.");
  }
  if (
    options.changed &&
    options.base !== undefined &&
    (typeof options.base !== "string" || options.base.trim().length === 0)
  ) {
    throw new Error("The --base option requires a non-empty reference.");
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
    format: format === "brief" ? "text" : format,
    timeoutMs,
    failOn,
    exclude,
    ...requestOptions(),
    changed: options.changed,
    ...(typeof options.base === "string" ? { baseRef: options.base } : {}),
  } as const;
  const scanned = await scanCodebase(request);
  const result = baseline === undefined
    ? scanned
    : withBaselineComparison(scanned, baseline.findings, {
        includeResolved: scanned.auditScope.mode === "full",
      });

  return { result, format, failOn };
}

function renderScanReport(
  result: ScanResult,
  format: OutputFormat,
  options: RepositoryCommandOptions,
): string {
  switch (format) {
    case "json":
      return renderJsonReport(result);
    case "sarif":
      return renderSarifReport(result);
    case "brief":
      return renderBriefReport(result, { maxFindings: parseMaxFindings(options.maxFindings) });
    default:
      return renderTextReport(result, {
        color: true,
        isTTY: process.stdout.isTTY === true,
        noColor: process.env.NO_COLOR !== undefined,
      });
  }
}

export function configureRepositoryCommand<Options extends RepositoryCommandOptions>(
  command: Command,
  requestOptions: (options: Options) => Partial<ScanRequest> = () => ({}),
  execute: (
    path: string,
    options: Options,
    requestOptions: () => Partial<ScanRequest>,
  ) => Promise<void> = executeScan,
): Command {
  return command
    .argument("[path]", "repository path", ".")
    .option("--run-checks", "permit execution of detected validation commands", false)
    .option(
      "--changed",
      "audit staged, unstaged, untracked, and branch changes",
      false,
    )
    .option("--base [ref]", "compare changed scope from the merge base with this ref")
    .option("--json", "emit machine-readable JSON", false)
    .option("--format <format>", "output format: text, json, sarif, or brief")
    .option("--exclude <glob>", "exclude a repository-relative path glob", collect, [])
    .option("--baseline <path>", "compare findings with a prior JSON report")
    .option("--timeout <ms>", "per-command timeout in milliseconds", String(DEFAULT_TIMEOUT_MS))
    .option(
      "--fail-on <severity>",
      "failure threshold: info, low, medium, high, critical, or none",
      "high",
    )
    .option(
      "--require-complete",
      "fail with exit code 2 when audit coverage is incomplete",
      false,
    )
    .option(
      "--max-findings <n>",
      "maximum findings rendered in brief output",
      String(DEFAULT_MAX_FINDINGS),
    )
    .action((path: string, options: Options) =>
      execute(path, options, () => requestOptions(options))
    );
}

export function createScanCommand(): Command {
  return configureRepositoryCommand(
    new Command("scan")
      .description("Inspect a repository and report evidence-backed findings."),
  );
}
