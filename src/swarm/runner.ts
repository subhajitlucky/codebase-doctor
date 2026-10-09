import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ScanResult } from "../core/normalize.js";
import { hasFindingAtOrAbove, type FindingThreshold } from "../core/summary.js";
import { buildReceipt, serializeReceipt } from "../receipts/receipt.js";
import {
  composeFleetVerdict,
  composeRepoVerdict,
  type RepoVerdict,
} from "./verdict.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 16;
const WORKER_TIMEOUT_MS = 300_000;

export interface SwarmOptions {
  roots: readonly string[];
  workers?: number;
  failOn: FindingThreshold;
  requireComplete: boolean;
  receiptDir?: string;
  json: boolean;
}

export interface SwarmRepoReport {
  root: string;
  verdict: RepoVerdict;
  score: number | null;
  findings: number;
  exitCode: number;
  unknownDomains: string[];
  gapDomains: string[];
  error?: string;
}

export interface SwarmOutcome {
  output: string;
  exitCode: 0 | 1 | 2;
  reports: SwarmRepoReport[];
  fleetVerdict: RepoVerdict;
}

function workerCommand(): { args: string[]; entry: string } {
  const entry = process.argv[1] ?? "";
  return entry.endsWith(".ts")
    ? { args: ["--import", "tsx"], entry }
    : { args: [], entry };
}

async function runWorker(root: string, failOn: FindingThreshold): Promise<{ report: SwarmRepoReport; result?: ScanResult }> {
  const { args, entry } = workerCommand();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [...args, entry, "audit", root, "--json", "--fail-on", failOn],
      {
        timeout: WORKER_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", DATABASE_URL: "", SUPABASE_DB_URL: "" },
      },
    );
    return parseWorkerOutput(root, stdout, 0, failOn);
  } catch (error) {
    const exitCode = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : 2;
    const stdout = typeof error === "object" && error !== null && "stdout" in error
      ? String((error as { stdout?: string }).stdout ?? "")
      : "";
    if (stdout.length > 0) {
      const parsed = parseWorkerOutput(root, stdout, exitCode, failOn);
      if (parsed.report.error === undefined) return parsed;
    }
    return {
      report: {
        root,
        verdict: "unknown",
        score: null,
        findings: 0,
        exitCode,
        unknownDomains: [],
        gapDomains: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function parseWorkerOutput(
  root: string,
  stdout: string,
  exitCode: number,
  failOn: FindingThreshold,
): { report: SwarmRepoReport; result?: ScanResult } {
  let result: ScanResult;
  try {
    result = JSON.parse(stdout) as ScanResult;
  } catch {
    return {
      report: {
        root,
        verdict: "unknown",
        score: null,
        findings: 0,
        exitCode,
        unknownDomains: [],
        gapDomains: [],
        error: "worker output was not parseable JSON",
      },
    };
  }
  const failedRuns = result.doctorRuns.filter((run) => run.status === "failed").length;
  const gatingFindings = hasFindingAtOrAbove(result.findings, failOn)
    ? result.findings.filter((finding) => finding.severity !== "info").length
    : 0;
  const composition = composeRepoVerdict(result.domainCoverage, gatingFindings, failedRuns);
  return {
    result,
    report: {
      root,
      verdict: composition.verdict,
      score: result.score?.value ?? null,
      findings: result.findings.length,
      exitCode,
      unknownDomains: composition.unknownDomains,
      gapDomains: composition.gapDomains,
    },
  };
}

function slug(root: string, index: number): string {
  const name = basename(root).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${String(index + 1).padStart(2, "0")}-${name.length === 0 ? "repo" : name}`;
}

/**
 * Verifier swarm: run one read-only verifier process per repository (bounded
 * parallelism), compose a per-repo verdict and a fleet verdict, and never
 * report a clean result when evidence was lost. Each worker can emit a
 * coverage receipt into --receipt-dir.
 */
export async function runSwarm(options: SwarmOptions): Promise<SwarmOutcome> {
  if (options.roots.length === 0) {
    throw new Error("swarm requires at least one repository path.");
  }
  const workers = Math.min(Math.max(1, options.workers ?? DEFAULT_WORKERS), MAX_WORKERS);

  const reports: SwarmRepoReport[] = new Array(options.roots.length);
  const results: (ScanResult | undefined)[] = new Array(options.roots.length);
  let next = 0;

  async function consume(): Promise<void> {
    while (next < options.roots.length) {
      const index = next;
      next += 1;
      const root = options.roots[index]!;
      const { report, result } = await runWorker(root, options.failOn);
      reports[index] = report;
      results[index] = result;
    }
  }

  await Promise.all(Array.from({ length: Math.min(workers, options.roots.length) }, () => consume()));

  if (options.receiptDir !== undefined) {
    await mkdir(options.receiptDir, { recursive: true });
    for (const [index, result] of results.entries()) {
      if (result === undefined) continue;
      const receipt = buildReceipt(result);
      await writeFile(
        join(options.receiptDir, `${slug(options.roots[index]!, index)}.receipt.json`),
        serializeReceipt(receipt),
        "utf8",
      );
    }
  }

  const fleetVerdict = composeFleetVerdict(reports.map((report) => report.verdict));
  const anyError = reports.some((report) => report.error !== undefined);
  const anyFailed = reports.some((report) => report.exitCode === 1);
  const incomplete = reports.some(
    (report) => report.verdict === "unknown" || report.verdict === "gaps",
  );
  const exitCode: 0 | 1 | 2 = anyError || (options.requireComplete && incomplete)
    ? 2
    : anyFailed
      ? 1
      : 0;

  const output = options.json
    ? `${JSON.stringify({ tool: "codebase-doctor-swarm", fleetVerdict, exitCode, reports }, null, 2)}\n`
    : renderSwarmText(options, reports, fleetVerdict, exitCode);

  return { output, exitCode, reports, fleetVerdict };
}

export function renderSwarmText(
  options: SwarmOptions,
  reports: readonly SwarmRepoReport[],
  fleetVerdict: RepoVerdict,
  exitCode: 0 | 1 | 2,
): string {
  const lines = [
    "Codebase Doctor Swarm",
    "=====================",
    "",
    `${reports.length} repositor${reports.length === 1 ? "y" : "ies"} verified with up to ${
      Math.min(Math.max(1, options.workers ?? DEFAULT_WORKERS), MAX_WORKERS)
    } worker(s).`,
    "",
  ];

  const width = Math.max(4, ...reports.map((report) => report.root.length));
  lines.push(
    `${"VERDICT".padEnd(9)} ${"REPO".padEnd(width)}  SCORE  FINDINGS  NOTES`,
  );
  for (const report of reports) {
    const notes: string[] = [];
    if (report.error !== undefined) notes.push(`error: ${report.error}`);
    if (report.unknownDomains.length > 0) notes.push(`unknown: ${report.unknownDomains.join(", ")}`);
    if (report.gapDomains.length > 0) notes.push(`gaps: ${report.gapDomains.join(", ")}`);
    lines.push(
      `${report.verdict.padEnd(9)} ${report.root.padEnd(width)}  ` +
      `${String(report.score ?? "—").padStart(5)}  ${String(report.findings).padStart(8)}  ` +
      `${notes.length === 0 ? "—" : notes.join(" · ")}`,
    );
  }

  lines.push(
    "",
    `Fleet verdict: ${fleetVerdict} (worst of ${reports.length})`,
    exitCode === 2
      ? "Exit code 2: a worker failed or --require-complete rejected incomplete coverage."
      : exitCode === 1
        ? "Exit code 1: at least one repository met the failure threshold."
        : "Exit code 0: no repository met the failure threshold.",
    "Unknown and gap states are listed per repository; a clean verdict is never claimed over lost evidence.",
  );
  return `${lines.join("\n")}\n`;
}
