import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedPath } from "../scope/types.js";

const execFileAsync = promisify(execFile);

// Bounded like the Git change discovery buffer: large enough for sizeable
// diffs while remaining deterministic and safe.
const GIT_DIFF_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Added-line index for one repository path.
 *
 * - A `Set<number>` holds the 1-based added line numbers from a zero-context
 *   unified diff.
 * - `"all"` means every line counts as changed (untracked files and added
 *   files whose hunk list is unavailable). Findings with or without a line
 *   number are in scope for these paths.
 */
export type ChangedLineSet = Set<number> | "all";

export type ChangedLines = Map<string, ChangedLineSet>;

export interface ChangedLinesRunner {
  run(root: string, args: readonly string[]): Promise<string>;
}

const defaultRunner: ChangedLinesRunner = {
  async run(root, args) {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_DIFF_BUFFER_BYTES,
    });
    return stdout;
  },
};

/**
 * Decode a C-style quoted pathname as emitted by Git when core.quotepath is
 * enabled (spaces are never quoted; only control bytes, quotes, backslashes,
 * and non-ASCII bytes are). Returns the input unchanged when unquoted.
 */
function unquotePath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  const inner = value.slice(1, -1);
  return inner.replace(/\\(\\|"|n|t|t|[0-7]{3})/g, (match, code: string) => {
    if (code === "n") return "\n";
    if (code === "t") return "\t";
    if (code === "\\" || code === '"') return code;
    return String.fromCharCode(parseInt(code, 8));
  }).replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (_match, u16: string, u32: string) =>
    String.fromCodePoint(parseInt(u16 ?? u32, 16)),
  );
}

function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  if (path.startsWith('"a/') || path.startsWith('"b/')) {
    return unquotePath(`"${path.slice(3)}`);
  }
  return unquotePath(path);
}

const HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a zero-context unified diff (`git diff -U0`) into added line numbers
 * per new file path. Pure function over diff text so it is unit-testable
 * without a repository.
 *
 * Deleted files (`+++ /dev/null`) contribute no added lines. Binary diffs
 * contribute none either; callers treat added/untracked paths without hunks
 * as `"all"`.
 */
export function parseUnifiedDiffZeroContext(diffText: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let currentPath: string | undefined;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      const target = stripPrefix(rawLine.slice(4).trim());
      currentPath = target === "/dev/null" ? undefined : target;
      if (currentPath !== undefined && !added.has(currentPath)) {
        added.set(currentPath, new Set());
      }
      continue;
    }
    if (currentPath === undefined) continue;
    const hunk = HUNK_PATTERN.exec(rawLine);
    if (hunk !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(count) && start >= 1 && count >= 0) {
        const lines = added.get(currentPath);
        for (let line = start; line < start + count; line += 1) {
          lines?.add(line);
        }
      }
    }
  }

  return added;
}

export interface ChangedLinesOptions {
  readonly root: string;
  readonly baseCommit: string;
  readonly changes: readonly ChangedPath[];
}

/**
 * Build the added-line index for a review: zero-context diff of the working
 * tree against the resolved base commit (mirroring `discoverGitChanges`
 * scope: staged plus unstaged changes), with untracked files marked `"all"`.
 *
 * Added files whose hunks are missing from the diff also fall back to `"all"`.
 * Throws the underlying git error so callers can fall back to file-level
 * filtering with an explicit precision note.
 */
export async function getChangedLines(
  options: ChangedLinesOptions,
  runner: ChangedLinesRunner = defaultRunner,
): Promise<ChangedLines> {
  const diffText = await runner.run(options.root, [
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--find-copies",
    options.baseCommit,
    "--",
  ]);
  const parsed = parseUnifiedDiffZeroContext(diffText);
  const result: ChangedLines = new Map(parsed);

  for (const change of options.changes) {
    if (change.status === "deleted") continue;
    if (change.status === "untracked") {
      result.set(change.path, "all");
      continue;
    }
    if ((change.status === "added" || change.status === "copied") && !result.has(change.path)) {
      result.set(change.path, "all");
    }
  }

  return result;
}
