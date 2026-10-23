import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { classifyScanExit } from "../core/normalize.js";
import { auditCodebase } from "../core/scan.js";
import type { FindingThreshold } from "../core/summary.js";
import { buildReceipt, serializeReceipt } from "../receipts/receipt.js";
import { renderBriefReport } from "../reporters/brief.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderTextReport } from "../reporters/text.js";

const execFileAsync = promisify(execFile);
const SHADOW_TIMEOUT_MS = 120_000;

export type ShadowFormat = "text" | "brief" | "json";

export interface ShadowOptions {
  root: string;
  runChecks: boolean;
  failOn: FindingThreshold;
  format: ShadowFormat;
  receipt?: string;
  receiptKeyPem?: string;
}

export interface ShadowOutcome {
  output: string;
  exitCode: 0 | 1 | 2;
}

function safeRelativePath(value: string): string | undefined {
  if (value.length === 0 || value.includes("\0")) return undefined;
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return undefined;
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

async function copyWorkingTree(root: string, destination: string): Promise<void> {
  const patchPath = join(destination, "..", ".codebase-doctor-working-tree.patch");
  try {
    const diff = await execFileAsync(
      "git",
      ["diff", "HEAD", "--binary", "--no-ext-diff"],
      { cwd: root, encoding: "utf8", timeout: SHADOW_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    if (diff.stdout.length > 0) {
      await writeFile(patchPath, diff.stdout, "utf8");
      await execFileAsync(
        "git",
        ["apply", "--whitespace=nowarn", patchPath],
        { cwd: destination, timeout: SHADOW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    }

    const untracked = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8", timeout: SHADOW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    for (const rawPath of untracked.stdout.split("\0")) {
      if (rawPath.length === 0) continue;
      const relativePath = safeRelativePath(rawPath);
      if (relativePath === undefined) {
        throw new Error(`Git returned an unsafe untracked path: ${JSON.stringify(rawPath)}`);
      }
      const source = join(root, ...relativePath.split("/"));
      const target = join(destination, ...relativePath.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, force: true, dereference: false });
    }
  } finally {
    await rm(patchPath, { force: true }).catch(() => undefined);
  }
}

export async function copyRepository(root: string, destination: string): Promise<void> {
  if (existsSync(join(root, ".git"))) {
    await execFileAsync(
      "git",
      ["clone", "--quiet", "--no-hardlinks", root, destination],
      { timeout: SHADOW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    // A clone contains only committed history. Mirror the working tree so
    // shadow audits cover staged, unstaged, deleted, renamed, and untracked
    // files exactly as review does.
    await copyWorkingTree(root, destination);
    return;
  }
  await cp(root, destination, {
    recursive: true,
    filter: (source) => !source.split("/").includes("node_modules"),
  });
}

/**
 * Mirror World: audit a disposable copy of the repository instead of the
 * original. Validation commands (`--run-checks`) execute inside the copy, so
 * repository-owned side effects cannot touch the working tree. The copy is
 * always removed; the original is never modified.
 */
export async function runShadow(options: ShadowOptions): Promise<ShadowOutcome> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codebase-doctor-shadow-"));
  const copyRoot = join(temporaryRoot, "repo");

  try {
    await copyRepository(options.root, copyRoot);

    const result = await auditCodebase({
      root: copyRoot,
      runChecks: options.runChecks,
      format: "text",
      timeoutMs: SHADOW_TIMEOUT_MS,
      failOn: options.failOn,
      includeDatabaseAudit: true,
      includeSecurityAudit: true,
    });
    const exitCode = classifyScanExit(result, options.failOn);

    const report = options.format === "brief"
      ? renderBriefReport(result)
      : options.format === "json"
        ? renderJsonReport(result)
        : renderTextReport(result, { color: false, isTTY: false });

    const lines = [
      "Codebase Doctor Shadow Audit",
      "============================",
      "",
      `Audited a disposable copy of ${options.root}.`,
      ...(options.runChecks
        ? ["Validation commands ran inside the copy, never in the original."]
        : []),
      "",
      report.trimEnd(),
      "",
      "Shadow guarantees: the copy was removed and the original repository was never modified.",
    ];

    if (options.receipt !== undefined) {
      const receipt = buildReceipt(result, {
        shadow: true,
        ...(options.receiptKeyPem === undefined ? {} : { privateKeyPem: options.receiptKeyPem }),
      });
      await writeFile(options.receipt, serializeReceipt(receipt), "utf8");
      process.stderr.write(`codebase-doctor: receipt written to ${options.receipt}\n`);
    }

    return { output: `${lines.join("\n")}\n`, exitCode };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
