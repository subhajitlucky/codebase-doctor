import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Finding } from "../core/findings.js";
import { auditCodebase } from "../core/scan.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_COMMITS = 200;
const AUDIT_TIMEOUT_MS = 120_000;

export interface BisectOptions {
  root: string;
  /** A rule id (`security/secrets/provider-token`) or an exact fingerprint. */
  target: string;
  maxCommits?: number;
  firstParent?: boolean;
}

export interface BisectEvidence {
  commit: string;
  parentCommit: string | null;
  message: string;
  author: string;
  authoredAt: string;
  ruleId: string;
  fingerprint: string;
  location?: string;
}

export interface BisectResult {
  target: string;
  scannedCommits: number;
  totalCommits: number;
  truncated: boolean;
  found: boolean;
  evidence?: BisectEvidence;
  note?: string;
}

export interface BisectOutcome {
  result: BisectResult;
  output: string;
  exitCode: 0 | 2;
}

interface CommitInfo {
  sha: string;
  parent: string | null;
  message: string;
  author: string;
  authoredAt: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
}

async function commitList(root: string, firstParent: boolean): Promise<string[]> {
  const args = ["rev-list", "--reverse"];
  if (firstParent) args.push("--first-parent");
  args.push("HEAD");
  return (await git(root, args))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function commitInfo(root: string, sha: string): Promise<CommitInfo> {
  const output = await git(root, ["show", "-s", "--format=%H%x00%P%x00%an%x00%aI%x00%s", sha]);
  const [fullSha, parents, author, authoredAt, message] = output.replace(/\n$/, "").split("\0");
  const firstParent = (parents ?? "").trim().split(/\s+/)[0];
  return {
    sha: fullSha ?? sha,
    parent: firstParent === undefined || firstParent.length === 0 ? null : firstParent,
    message: message ?? "",
    author: author ?? "",
    authoredAt: authoredAt ?? "",
  };
}

function matchesTarget(finding: Finding, target: string): boolean {
  return finding.ruleId === target || finding.fingerprint === target;
}

/**
 * Chronological Doctor: replay the repository commit by commit (oldest first,
 * first-parent by default) in disposable git worktrees and report the first
 * commit where the target rule or fingerprint appears. The parent commit was
 * verified absent by the scan immediately before, so the evidence chain is
 * "present here, absent in the parent".
 */
export async function runBisect(options: BisectOptions): Promise<BisectOutcome> {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const firstParent = options.firstParent ?? true;

  try {
    await git(options.root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`${options.root} is not a git repository with a HEAD commit.`);
  }

  const commits = await commitList(options.root, firstParent);
  const scanned = commits.slice(0, maxCommits);

  for (const [index, sha] of scanned.entries()) {
    const worktree = await mkdtemp(join(tmpdir(), "codebase-doctor-bisect-"));
    try {
      await git(options.root, ["worktree", "add", "--detach", "--quiet", worktree, sha]);
      const result = await auditCodebase({
        root: worktree,
        runChecks: false,
        format: "text",
        timeoutMs: AUDIT_TIMEOUT_MS,
        failOn: "none",
        includeDatabaseAudit: true,
        includeSecurityAudit: true,
      });
      const finding = result.findings.find((entry) => matchesTarget(entry, options.target));
      if (finding !== undefined) {
        const info = await commitInfo(options.root, sha);
        const evidence: BisectEvidence = {
          commit: info.sha,
          parentCommit: info.parent,
          message: info.message,
          author: info.author,
          authoredAt: info.authoredAt,
          ruleId: finding.ruleId,
          fingerprint: finding.fingerprint,
          ...(finding.location === undefined
            ? {}
            : {
                location: `${finding.location.path}${
                  finding.location.line === undefined ? "" : `:${finding.location.line}`
                }`,
              }),
        };
        const result_: BisectResult = {
          target: options.target,
          scannedCommits: index + 1,
          totalCommits: commits.length,
          truncated: commits.length > scanned.length,
          found: true,
          evidence,
        };
        return { result: result_, output: renderBisectText(result_), exitCode: 0 };
      }
    } finally {
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
      await git(options.root, ["worktree", "prune"]).catch(() => undefined);
    }
  }

  const result: BisectResult = {
    target: options.target,
    scannedCommits: scanned.length,
    totalCommits: commits.length,
    truncated: commits.length > scanned.length,
    found: false,
    note: commits.length > scanned.length
      ? `Not found in the first ${scanned.length} commit(s); raise --max-commits to scan further.`
      : "Not found in any commit on the scanned history.",
  };
  return { result, output: renderBisectText(result), exitCode: 0 };
}

export function renderBisectText(result: BisectResult): string {
  const lines = [
    "Codebase Doctor Bisect",
    "======================",
    "",
    `Target: ${result.target}`,
    `History scanned: ${result.scannedCommits} of ${result.totalCommits} commit(s)` +
    `${result.truncated ? " (truncated; raise --max-commits to continue)" : ""}`,
    "",
  ];

  if (result.found && result.evidence !== undefined) {
    const evidence = result.evidence;
    lines.push(
      `Introduced in commit ${evidence.commit}`,
      `  ${evidence.authoredAt} · ${evidence.author} · "${evidence.message}"`,
      `  Rule: ${evidence.ruleId}${evidence.location === undefined ? "" : ` at ${evidence.location}`}`,
      `  Fingerprint: ${evidence.fingerprint}`,
      evidence.parentCommit === null
        ? "  Evidence: this is the root commit of the scanned history."
        : `  Evidence: present in ${evidence.commit}, absent in its parent ${evidence.parentCommit} (scanned immediately before).`,
    );
  } else {
    lines.push(result.note ?? "Target not found.");
  }

  lines.push(
    "",
    "Read-only: each commit was audited in a disposable git worktree; the working tree was never modified.",
  );
  return `${lines.join("\n")}\n`;
}
