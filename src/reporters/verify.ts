import type { VerifyEntry, VerifyResult } from "../core/verify.js";
import { VERSION } from "../version.js";

export function renderVerifyJson(verification: VerifyResult): string {
  return `${JSON.stringify(
    { tool: { name: "codebase-doctor", version: VERSION }, ...verification },
    null,
    2,
  )}\n`;
}

function entryLine(entry: VerifyEntry): string {
  const location =
    entry.location === undefined
      ? "(repository)"
      : `${entry.location.path}${
          entry.location.line === undefined ? "" : `:${entry.location.line}`
        }`;
  return `- [${entry.status}] ${entry.severity} ${entry.ruleId} ${location} — ${entry.title}`;
}

function summaryLine(verification: VerifyResult): string {
  const { counts } = verification;
  return (
    `resolved=${counts.resolved} unchanged=${counts.unchanged} ` +
    `unresolved=${counts.unresolved} new=${counts.new} ` +
    `coverage=${verification.coverageComplete ? "complete" : "incomplete"}`
  );
}

export function renderVerifyText(verification: VerifyResult): string {
  const lines = [
    "Codebase Doctor Verify",
    `Scope: ${verification.scope.mode}`,
    `Coverage: ${verification.coverageComplete ? "complete" : "incomplete"}`,
    `Baseline: ${verification.baseline.length} finding(s); ${summaryLine(verification)}`,
  ];

  if (verification.coverageLimitations.length > 0) {
    lines.push(`Coverage limitations: ${verification.coverageLimitations.join(", ")}`);
  }

  lines.push("");
  if (verification.baseline.length === 0) {
    lines.push("(baseline is empty)");
  } else {
    for (const entry of verification.baseline) lines.push(entryLine(entry));
  }

  if (verification.newFindings.length > 0) {
    lines.push("");
    lines.push("New findings");
    for (const entry of verification.newFindings) lines.push(entryLine(entry));
  }

  return `${lines.join("\n")}\n`;
}

export function renderVerifyBrief(verification: VerifyResult): string {
  const lines = [
    "codebase-doctor verify",
    `scope=${verification.scope.mode} ${summaryLine(verification)}`,
  ];

  for (const entry of verification.baseline) {
    if (entry.status !== "resolved") lines.push(entryLine(entry));
  }
  for (const entry of verification.newFindings) lines.push(entryLine(entry));

  if (verification.coverageLimitations.length > 0) {
    lines.push(`coverage-limitations: ${verification.coverageLimitations.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}
