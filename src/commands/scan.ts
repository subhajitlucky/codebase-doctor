import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { loadCodebaseConfig, validateExcludePattern } from "../config/config.js";
import { loadBaseline, withBaselineComparison } from "../core/baseline.js";
import { classifyScanExit, type ScanResult } from "../core/normalize.js";
import { scanCodebase, type ScanRequest } from "../core/scan.js";
import type { FindingThreshold } from "../core/summary.js";
import { buildReceipt, serializeReceipt } from "../receipts/receipt.js";
import { buildPheromone, serializePheromone } from "../pheromones/pheromone.js";
import { renderBriefReport } from "../reporters/brief.js";
import { renderHtmlReport } from "../reporters/html.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderSarifReport } from "../reporters/sarif.js";
import { renderScoreOutput } from "../reporters/score.js";
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
  score: boolean;
  badge: boolean;
  receipt?: string;
  receiptKey?: string;
  pheromone?: string;
}

type OutputFormat = "text" | "json" | "sarif" | "brief" | "html";
const OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "sarif", "brief", "html"]);

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

export function parseThreshold(value: string): FindingThreshold {
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

export function parseMaxFindings(value: string): number {
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
    const scoreOutput = renderScoreOutput(result, options);
    process.stdout.write(scoreOutput ?? renderScanReport(result, format, options));
    if (options.receipt !== undefined) {
      const privateKeyPem = options.receiptKey === undefined
        ? undefined
        : await readFile(options.receiptKey, "utf8");
      const receipt = buildReceipt(result, {
        ...(privateKeyPem === undefined ? {} : { privateKeyPem }),
      });
      await writeFile(options.receipt, serializeReceipt(receipt), "utf8");
      process.stderr.write(`codebase-doctor: receipt written to ${options.receipt}\n`);
    }
    if (options.pheromone !== undefined) {
      const privateKeyPem = options.receiptKey === undefined
        ? undefined
        : await readFile(options.receiptKey, "utf8");
      const signal = buildPheromone(result, {
        ...(privateKeyPem === undefined ? {} : { privateKeyPem }),
      });
      await writeFile(options.pheromone, serializePheromone(signal), "utf8");
      process.stderr.write(`codebase-doctor: pheromone signal written to ${options.pheromone}\n`);
    }
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
    format: format === "brief" || format === "html" ? "text" : format,
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
    case "html":
      return renderHtmlReport(result);
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
    .option("--format <format>", "output format: text, json, sarif, brief, or html")
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

export function addScoreOptions(command: Command): Command {
  return command
    .option("--score", "print only the Repo Health score, e.g. Repo Health: 71/100", false)
    .option("--badge", "print a shields.io badge URL for the Repo Health score", false);
}

export function addReceiptOptions(command: Command): Command {
  return command
    .option("--receipt <path>", "write a portable coverage receipt to this path")
    .option("--receipt-key <path>", "sign the receipt with an Ed25519 private key (PEM)")
    .option(
      "--pheromone <path>",
      "write a privacy-bounded pheromone signal (rules and counts only; no paths or fingerprints)",
    );
}

export function createScanCommand(): Command {
  return addReceiptOptions(addScoreOptions(configureRepositoryCommand(
    new Command("scan")
      .description("Inspect a repository and report evidence-backed findings."),
  )));
}
