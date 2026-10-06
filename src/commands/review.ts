import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { normalizeDatabaseSchemas, parseDatabaseTimeout } from "./audit.js";
import {
  configureRepositoryCommand,
  parseMaxFindings,
  runRepositoryScan,
  type RepositoryCommandOptions,
} from "./scan.js";
import type { ScanRequest } from "../core/scan.js";
import { summarizeFindings } from "../core/summary.js";
import type { ScanResult } from "../core/normalize.js";
import { getChangedLines, type ChangedLines } from "../review/changed-lines.js";
import { summarizeReview } from "../review/summary.js";
import { classifyReviewExit, type ReviewVerdict } from "../review/verdict.js";
import { renderBriefReport } from "../reporters/brief.js";
import { renderGithubAnnotations } from "../reporters/github.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderMarkdownReview } from "../reporters/markdown.js";
import { renderSarifReport } from "../reporters/sarif.js";
import { renderTextReport } from "../reporters/text.js";

const DEFAULT_DATABASE_TIMEOUT_MS = 10_000;

export type ReviewFormat = "text" | "json" | "sarif" | "brief" | "markdown" | "github";

const REVIEW_FORMATS = new Set<ReviewFormat>([
  "text",
  "json",
  "sarif",
  "brief",
  "markdown",
  "github",
]);

export interface ReviewCommandOptions extends RepositoryCommandOptions {
  withDatabase: boolean;
  withAdvisories: boolean;
  databaseSchema: string[];
  databaseTimeout: string;
  allFindings: boolean;
  output?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseReviewFormat(options: ReviewCommandOptions): ReviewFormat {
  if (options.format !== undefined && !REVIEW_FORMATS.has(options.format as ReviewFormat)) {
    throw new Error(`Invalid review output format "${options.format}".`);
  }
  if (options.json && options.format !== undefined && options.format !== "json") {
    throw new Error("The --json and --format options conflict.");
  }
  return options.json ? "json" : (options.format as ReviewFormat | undefined) ?? "text";
}

function databaseRequest(options: ReviewCommandOptions): Partial<ScanRequest> {
  return {
    includeDatabaseAudit: true,
    includeSecurityAudit: true,
    withDatabase: options.withDatabase,
    withAdvisories: options.withAdvisories,
    databaseSchemas: normalizeDatabaseSchemas(options.databaseSchema),
    databaseTimeoutMs: parseDatabaseTimeout(options.databaseTimeout),
  };
}

export interface ReviewReport {
  report: string;
  verdict: ReviewVerdict;
  findingsInDiff: number;
  totalFindings: number;
  excludedCount: number;
  linePrecision: boolean;
  exitCode: 0 | 1 | 2;
}

/**
 * Run a changed-scope audit narrowed to the review diff and render it in a
 * code-review format. The full audit result stays available for totals and
 * baseline comparison; only diff-touching findings drive the verdict.
 */
export async function runReview(
  path: string,
  options: ReviewCommandOptions,
): Promise<ReviewReport> {
  const format = parseReviewFormat(options);
  const maxFindings = parseMaxFindings(options.maxFindings);
  const { format: _ignoredFormat, json: _ignoredJson, ...rest } = options;
  const scanOptions = {
    ...rest,
    changed: true as const,
    // The scan pipeline only knows text/json/sarif/brief; review-only formats
    // reuse the text scan and render separately.
    json: format === "json",
    ...(format === "json" ? {} : { format: "text" }),
  };
  const { result, failOn } = await runRepositoryScan(path, scanOptions, () =>
    databaseRequest(options),
  );

  let changedLines: ChangedLines | undefined;
  try {
    changedLines = result.auditScope.base === null
      ? undefined
      : await getChangedLines({
        root: result.repository.root,
        baseCommit: result.auditScope.base.resolvedCommit,
        changes: result.auditScope.changes,
      });
  } catch {
    changedLines = undefined;
  }

  const summary = summarizeReview(result, changedLines, failOn, {
    allFindings: options.allFindings,
  });
  const { verdict } = summary;
  const filteredResult: ScanResult = {
    ...result,
    findings: summary.included,
    summary: summarizeFindings(summary.included),
  };

  const baselineFiltered = summary.baselineFiltered;
  let report: string;
  switch (format) {
    case "json": {
      const envelope = {
        ...JSON.parse(renderJsonReport(filteredResult)),
        review: {
          verdict,
          failOn,
          findingsInDiff: summary.included.length,
          totalFindings: result.findings.length,
          excludedCount: summary.excluded.length,
          linePrecision: summary.linePrecision,
          allFindings: options.allFindings,
          baselineFiltered,
        },
      };
      report = `${JSON.stringify(envelope, null, 2)}\n`;
      break;
    }
    case "sarif":
      report = renderSarifReport(filteredResult);
      break;
    case "brief": {
      const header =
        `review verdict=${verdict} findings-in-diff=${summary.included.length} ` +
        `total=${result.findings.length} fail-on=${failOn}\n`;
      const body = renderBriefReport(filteredResult, { maxFindings });
      const footer = summary.excluded.length === 0
        ? ""
        : `outside-diff: ${summary.excluded.length} finding(s) omitted; rerun with --all-findings\n`;
      report = `${header}${body}${footer}`;
      break;
    }
    case "markdown": {
      const baseOption = typeof options.base === "string" && options.base.trim().length > 0
        ? ` --base ${options.base.trim()}`
        : "";
      report = renderMarkdownReview(result, summary.included, {
        verdict,
        failOn,
        maxFindings,
        excludedCount: summary.excluded.length,
        baselineFiltered,
        linePrecision: summary.linePrecision,
        rerunCommand: `codebase-doctor review . --format markdown${baseOption}`,
      });
      break;
    }
    case "github":
      report = renderGithubAnnotations(summary.included, {
        verdict,
        maxFindings,
        excludedCount: summary.excluded.length,
      });
      break;
    default: {
      const header =
        `Review verdict: ${verdict} (fail-on ${failOn}; ` +
        `${summary.included.length} finding(s) in diff, ${result.findings.length} total)\n`;
      const body = renderTextReport(filteredResult, {
        color: true,
        isTTY: process.stdout.isTTY === true,
        noColor: process.env.NO_COLOR !== undefined,
      });
      const footer = summary.excluded.length === 0
        ? ""
        : `\nReview: ${summary.excluded.length} finding(s) outside the changed lines omitted from this review (rerun with --all-findings to include them).\n`;
      const precisionNote = summary.linePrecision
        ? ""
        : "Review: changed-line mapping was unavailable; file-level filtering applied.\n";
      report = `${header}${precisionNote}${body}${footer}`;
      break;
    }
  }

  const coverageComplete = result.domainCoverage.every((domain) => domain.coverageComplete);
  const doctorFailed = result.doctorRuns.some((run) => run.status === "failed");
  const exitCode = classifyReviewExit(summary.verdictFindings, failOn, doctorFailed, coverageComplete, {
    requireComplete: options.requireComplete,
  });

  return {
    report,
    verdict,
    findingsInDiff: summary.included.length,
    totalFindings: result.findings.length,
    excludedCount: summary.excluded.length,
    linePrecision: summary.linePrecision,
    exitCode,
  };
}

async function executeReview(
  path: string,
  options: ReviewCommandOptions,
  requestOptions: () => Partial<ScanRequest> = () => ({}),
): Promise<void> {
  void requestOptions;
  try {
    if (
      options.base !== undefined && typeof options.base !== "boolean" &&
      (typeof options.base !== "string" || options.base.trim().length === 0)
    ) {
      throw new Error("The --base option requires a non-empty reference.");
    }
    const review = await runReview(path, options);
    if (options.output !== undefined) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, review.report, "utf8");
    }
    process.stdout.write(review.report);
    process.exitCode = review.exitCode;
    if (options.requireComplete && review.exitCode === 2) {
      process.stderr.write(
        "codebase-doctor: review coverage is incomplete and --require-complete was set; failing with exit code 2.\n",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codebase-doctor: ${message}\n`);
    process.exitCode = 2;
  }
}

export function createReviewCommand(): Command {
  const command = new Command("review")
    .description(
      "Review changed code with a PR-ready verdict. Always audits changed scope " +
      "and narrows findings to the diff lines (--changed is implied).",
    )
    .option(
      "--all-findings",
      "include findings outside the changed lines in the review",
      false,
    )
    .option("--output <file>", "write the review report to a file as well as stdout")
    .option(
      "--with-database",
      "permit a live PostgreSQL RLS audit using environment credentials",
      false,
    )
    .option(
      "--database-schema <schema>",
      "database schema to audit; repeatable (default: public)",
      collect,
      [],
    )
    .option(
      "--database-timeout <ms>",
      "PostgreSQL catalog statement timeout in milliseconds",
      String(DEFAULT_DATABASE_TIMEOUT_MS),
    )
    .option(
      "--with-advisories",
      "permit one opt-in OSV advisory lookup over resolved npm packages (network)",
      false,
    );

  const configured = configureRepositoryCommand<ReviewCommandOptions>(
    command,
    databaseRequest,
    executeReview,
  );
  for (const option of configured.options) {
    if (option.long === "--format") {
      option.description = "output format: text, json, sarif, brief, markdown, or github";
    }
    if (option.long === "--changed") {
      option.description = "implied for review; accepted for compatibility";
    }
    if (option.long === "--max-findings") {
      option.description = "maximum findings rendered in brief, markdown, and github output";
    }
  }
  return configured;
}
