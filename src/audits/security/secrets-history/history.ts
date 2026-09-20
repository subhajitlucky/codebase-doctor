import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Confidence, Severity } from "../../../core/findings.js";
import { analyzeSecrets } from "../secrets/analyzer.js";
import type { SecretFindingFamily } from "../secrets/types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_MAX_PATCH_BYTES = 20_000_000;
const COMMIT_MARKER = /^@@@([0-9a-f]{40})$/u;
const FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/u;

export interface HistoryMatch {
  readonly detectorId: string;
  readonly family: SecretFindingFamily;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly path: string;
  readonly commit: string;
  readonly occurrences: number;
}

export interface HistoryScanResult {
  readonly status: "completed" | "partial";
  readonly commitsExamined: number;
  readonly filesExamined: number;
  readonly addedLinesExamined: number;
  readonly matches: readonly HistoryMatch[];
  readonly limitations: readonly string[];
}

export interface HistoryScanOptions {
  readonly maxCommits?: number;
  readonly maxPatchBytes?: number;
}

interface MutableHistoryMatch {
  detectorId: string;
  family: SecretFindingFamily;
  severity: Severity;
  confidence: Confidence;
  path: string;
  commit: string;
  occurrences: number;
}

/**
 * Scans added lines across recent Git history for credential-shaped values, so
 * a credential deleted from the working tree but still reachable in history is
 * reported. Uses fixed read-only git commands; values are withheld.
 */
export async function scanGitHistory(
  root: string,
  options: HistoryScanOptions = {},
): Promise<HistoryScanResult> {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const limitations: string[] = [];
  let status: HistoryScanResult["status"] = "completed";
  let stdout = "";

  try {
    const result = await execFileAsync(
      "git",
      [
        "log",
        "--all",
        "--no-merges",
        "--no-color",
        "-p",
        "-U0",
        "--format=@@@%H",
        "-n",
        String(maxCommits),
        "--",
        ".",
      ],
      { cwd: root, maxBuffer: maxPatchBytes, encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch (error) {
    const partial = (error as { stdout?: unknown }).stdout;
    stdout = typeof partial === "string" ? partial : "";
    status = "partial";
    limitations.push(
      `Git history scan did not complete: ${
        error instanceof Error ? error.message : String(error)
      } Deleted-credential coverage is incomplete, and zero history findings is not a clean result.`,
    );
  }

  const byIdentity = new Map<string, MutableHistoryMatch>();
  const commits = new Set<string>();
  let commit: string | undefined;
  let path: string | undefined;
  let buffer: string[] = [];
  let filesExamined = 0;
  let addedLinesExamined = 0;

  const flush = (): void => {
    if (commit !== undefined && path !== undefined && buffer.length > 0) {
      filesExamined += 1;
      for (const match of analyzeSecrets(buffer.join("\n"))) {
        const identity = `${match.detectorId}\u0000${path}`;
        const existing = byIdentity.get(identity);
        if (existing === undefined) {
          byIdentity.set(identity, {
            detectorId: match.detectorId,
            family: match.family,
            severity: match.severity,
            confidence: match.confidence,
            path,
            commit,
            occurrences: 1,
          });
        } else {
          existing.occurrences += 1;
        }
      }
    }
    buffer = [];
  };

  for (const line of stdout.split("\n")) {
    const commitMatch = COMMIT_MARKER.exec(line);
    if (commitMatch?.[1] !== undefined) {
      flush();
      commit = commitMatch[1];
      commits.add(commit);
      path = undefined;
      continue;
    }

    if (line.startsWith("+++ ")) {
      flush();
      const fileMatch = FILE_HEADER.exec(line);
      const candidate = fileMatch?.[1];
      path = candidate === undefined || candidate === "/dev/null" ? undefined : candidate;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++") && path !== undefined) {
      buffer.push(line.slice(1));
      addedLinesExamined += 1;
    }
  }
  flush();

  const matches = [...byIdentity.values()]
    .map((match): HistoryMatch => ({ ...match }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.detectorId.localeCompare(right.detectorId) ||
        left.commit.localeCompare(right.commit),
    );

  return {
    status,
    commitsExamined: commits.size,
    filesExamined,
    addedLinesExamined,
    matches,
    limitations,
  };
}
