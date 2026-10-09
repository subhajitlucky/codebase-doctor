import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ScanResult } from "../core/normalize.js";
import { auditCodebase } from "../core/scan.js";
import { canonicalJson } from "../receipts/receipt.js";
import { copyRepository } from "../shadow/runner.js";
import type { ImportRepairPlan } from "./repair.js";

const execFileAsync = promisify(execFile);

export interface RepairVerification {
  status: "verified" | "failed";
  mode: "static+shadow";
  resolved: string[];
  newFindings: string[];
  advisoryFindings: string[];
  reasons: string[];
  limitations: string[];
}

export interface RepairReceipt {
  repairVersion: "1";
  tool: { name: "codebase-doctor"; version: string };
  generatedAt: string;
  subject: {
    root: string;
    finding: { ruleId: string; fingerprint: string; location?: string };
    repair: { file: string; from: string; to: string };
  };
  patch: { format: "git-diff" | "line-replacement"; text: string; sha256: string };
  verification: RepairVerification;
  digest: { algorithm: "sha256"; value: string };
}

function fingerprintSet(result: ScanResult): Map<string, string> {
  return new Map(result.findings.map((finding) => [finding.fingerprint, finding.severity]));
}

export interface ImportRepairOutcome {
  verification: RepairVerification;
  patchText: string;
  patchFormat: "git-diff" | "line-replacement";
}

/**
 * Shadow verification: copy the repository, apply the patched file in the
 * copy, re-audit, and require the target fingerprint to disappear with no
 * new medium-or-higher findings. The original repository is never modified.
 */
export async function verifyImportRepair(
  root: string,
  plan: ImportRepairPlan,
  originalResult: ScanResult,
): Promise<ImportRepairOutcome> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codebase-doctor-fix-"));
  const copyRoot = join(temporaryRoot, "repo");
  const limitations: string[] = [];

  try {
    await copyRepository(root, copyRoot);
    const copiedFile = join(copyRoot, ...plan.file.split("/"));
    await writeFile(copiedFile, plan.patchedContent, "utf8");

    let patchText: string;
    let patchFormat: "git-diff" | "line-replacement";
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--", plan.file], {
        cwd: copyRoot,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (stdout.trim().length > 0) {
        patchText = stdout;
        patchFormat = "git-diff";
      } else {
        throw new Error("empty diff");
      }
    } catch {
      patchText =
        `--- a/${plan.file}\n+++ b/${plan.file}\n` +
        `-  "${plan.originalSpecifier}"\n+  "${plan.replacementSpecifier}"\n`;
      patchFormat = "line-replacement";
      limitations.push("The repository is not a git checkout; the patch is a line replacement, not a diff.");
    }

    const after = await auditCodebase({
      root: copyRoot,
      runChecks: false,
      format: "text",
      timeoutMs: 120_000,
      failOn: "none",
      includeDatabaseAudit: true,
      includeSecurityAudit: true,
    });

    const before = fingerprintSet(originalResult);
    const resolved = before.has(plan.fingerprint) && !after.findings.some(
      (finding) => finding.fingerprint === plan.fingerprint,
    )
      ? [`${plan.ruleId} ${plan.file}`]
      : [];
    const introduced = after.findings.filter((finding) => !before.has(finding.fingerprint));
    const blocking = introduced.filter(
      (finding) => finding.severity !== "info" && finding.severity !== "low",
    );
    const advisory = introduced.filter(
      (finding) => finding.severity === "info" || finding.severity === "low",
    );
    const failedRuns = after.doctorRuns.filter((run) => run.status === "failed");
    const reasons: string[] = [];
    if (resolved.length === 0) {
      reasons.push("the patch did not resolve the target finding");
    }
    if (blocking.length > 0) {
      reasons.push(`${blocking.length} new medium+ finding(s) were introduced by the patch`);
    }
    if (failedRuns.length > 0) {
      reasons.push(`${failedRuns.length} doctor run(s) failed while verifying the patch`);
    }

    return {
      patchText,
      patchFormat,
      verification: {
        status: reasons.length === 0 ? "verified" : "failed",
        mode: "static+shadow",
        resolved,
        newFindings: blocking.map((finding) => `${finding.severity} ${finding.ruleId}`),
        advisoryFindings: advisory.map((finding) => `${finding.severity} ${finding.ruleId}`),
        reasons,
        limitations,
      },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function buildRepairReceipt(
  plan: ImportRepairPlan,
  outcome: ImportRepairOutcome,
  root: string,
  toolVersion: string,
  generatedAt: Date = new Date(),
): RepairReceipt {
  const body = {
    repairVersion: "1" as const,
    tool: { name: "codebase-doctor" as const, version: toolVersion },
    generatedAt: generatedAt.toISOString(),
    subject: {
      root,
      finding: {
        ruleId: plan.ruleId,
        fingerprint: plan.fingerprint,
        ...(plan.file.length === 0 ? {} : { location: plan.file }),
      },
      repair: { file: plan.file, from: plan.originalSpecifier, to: plan.replacementSpecifier },
    },
    patch: {
      format: outcome.patchFormat,
      text: outcome.patchText,
      sha256: createHash("sha256").update(outcome.patchText, "utf8").digest("hex"),
    },
    verification: outcome.verification,
  };
  return {
    ...body,
    digest: {
      algorithm: "sha256",
      value: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"),
    },
  };
}

export function renderRepairText(receipt: RepairReceipt): string {
  const lines = [
    "Codebase Doctor Verified Repair",
    "===============================",
    "",
    `Finding: ${receipt.subject.finding.ruleId} ${receipt.subject.finding.location ?? ""}`,
    `Repair:  ${receipt.subject.repair.file} — "${receipt.subject.repair.from}" -> "${receipt.subject.repair.to}"`,
    `Patch:   ${receipt.patch.sha256.slice(0, 16)}… (${receipt.patch.format})`,
    `Verification: ${receipt.verification.status} (${receipt.verification.mode})`,
    "",
    `Resolved: ${receipt.verification.resolved.length}`,
  ];
  for (const entry of receipt.verification.resolved) lines.push(`  + ${entry}`);
  if (receipt.verification.newFindings.length > 0) {
    lines.push(`New findings introduced: ${receipt.verification.newFindings.length}`);
    for (const entry of receipt.verification.newFindings) lines.push(`  ! ${entry}`);
  }
  if (receipt.verification.advisoryFindings.length > 0) {
    lines.push(`Advisory (non-blocking): ${receipt.verification.advisoryFindings.length}`);
    for (const entry of receipt.verification.advisoryFindings) lines.push(`  ~ ${entry}`);
  }
  for (const reason of receipt.verification.reasons) lines.push(`Reason: ${reason}`);
  for (const limitation of receipt.verification.limitations) lines.push(`Limitation: ${limitation}`);
  lines.push(
    "",
    receipt.verification.status === "verified"
      ? "The patch is verified in a disposable copy: apply it, then rerun `audit` and `verify` on the same scope."
      : "The patch is NOT verified and was not written. Nothing was applied.",
    "Read-only: the tool never modified the original repository.",
  );
  return `${lines.join("\n")}\n`;
}
