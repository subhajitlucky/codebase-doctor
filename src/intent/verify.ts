import { createHash } from "node:crypto";
import type { AuditDomain } from "../core/domain-coverage.js";
import type { ScanResult } from "../core/normalize.js";
import { scoreScanResult } from "../core/score.js";
import { coverageLimitations } from "../core/verify.js";
import { canonicalJson } from "../receipts/receipt.js";
import type { IntentClaim } from "./parse.js";

export type IntentClaimStatus = "verified" | "violated" | "undecided";

export interface IntentClaimResult {
  id: string;
  kind: IntentClaim["kind"];
  status: IntentClaimStatus;
  reason: string;
  evidence: string[];
}

export interface IntentReport {
  intentVersion: "1";
  tool: { name: "codebase-doctor"; version: string };
  generatedAt: string;
  subject: { path: string; intentSource: string };
  summary: { claims: number; verified: number; violated: number; undecided: number };
  claims: IntentClaimResult[];
  unstructuredCharacters: number;
  digest: { algorithm: "sha256"; value: string };
}

const MAX_EVIDENCE = 5;

const DOMAIN_BY_PREFIX: Record<string, AuditDomain> = {
  security: "security",
  source: "repository",
  repository: "repository",
  backend: "backend",
  frontend: "frontend",
  infrastructure: "infrastructure",
  database: "database",
  performance: "performance",
  ai: "ai",
};

function domainForRule(ruleId: string): AuditDomain | undefined {
  return DOMAIN_BY_PREFIX[ruleId.split("/")[0] ?? ""];
}

function location(finding: ScanResult["findings"][number]): string {
  if (finding.location === undefined) return "(repository)";
  return `${finding.location.path}${finding.location.line === undefined ? "" : `:${finding.location.line}`}`;
}

function coverageReason(result: ScanResult, ruleId: string): string | undefined {
  const domain = domainForRule(ruleId);
  if (domain === undefined) {
    return `rule "${ruleId}" has no coverage-domain mapping`;
  }
  const entry = result.domainCoverage.find((candidate) => candidate.domain === domain);
  if (entry === undefined) {
    return `coverage for ${domain} is absent from the report`;
  }
  if (!entry.coverageComplete) {
    return `coverage for ${domain} is incomplete (${entry.status})`;
  }
  return undefined;
}

function evaluateClaim(claim: IntentClaim, result: ScanResult): IntentClaimResult {
  switch (claim.kind) {
    case "rule-absent":
    case "rule-present": {
      const matches = result.findings.filter((finding) =>
        finding.ruleId === claim.ruleId &&
        (claim.pathPrefix === undefined ||
          (finding.location?.path.startsWith(claim.pathPrefix) ?? false))
      );
      const evidence = matches.slice(0, MAX_EVIDENCE).map(location);
      const scope = claim.pathPrefix === undefined ? "" : ` under ${claim.pathPrefix}`;
      if (claim.kind === "rule-absent") {
        if (matches.length > 0) {
          return {
            id: claim.id,
            kind: claim.kind,
            status: "violated",
            reason: `${matches.length} finding(s) with ${claim.ruleId}${scope}`,
            evidence,
          };
        }
        const gap = coverageReason(result, claim.ruleId);
        return gap === undefined
          ? {
              id: claim.id,
              kind: claim.kind,
              status: "verified",
              reason: `no finding with ${claim.ruleId}${scope} within complete coverage`,
              evidence: [],
            }
          : { id: claim.id, kind: claim.kind, status: "undecided", reason: gap, evidence: [] };
      }
      if (matches.length > 0) {
        return {
          id: claim.id,
          kind: claim.kind,
          status: "verified",
          reason: `${matches.length} finding(s) with ${claim.ruleId}${scope}`,
          evidence,
        };
      }
      const gap = coverageReason(result, claim.ruleId);
      return gap === undefined
        ? {
            id: claim.id,
            kind: claim.kind,
            status: "violated",
            reason: `no finding with ${claim.ruleId}${scope} within complete coverage`,
            evidence: [],
          }
        : { id: claim.id, kind: claim.kind, status: "undecided", reason: gap, evidence: [] };
    }
    case "score-at-least": {
      const score = scoreScanResult(result).value;
      return score >= claim.value
        ? {
            id: claim.id,
            kind: claim.kind,
            status: "verified",
            reason: `score ${score} >= ${claim.value}`,
            evidence: [],
          }
        : {
            id: claim.id,
            kind: claim.kind,
            status: "violated",
            reason: `score ${score} < ${claim.value}`,
            evidence: [],
          };
    }
    case "coverage-complete": {
      const limitations = coverageLimitations(result);
      return limitations.length === 0
        ? {
            id: claim.id,
            kind: claim.kind,
            status: "verified",
            reason: "every applicable domain completed",
            evidence: [],
          }
        : {
            id: claim.id,
            kind: claim.kind,
            status: "violated",
            reason: `${limitations.length} coverage limitation(s)`,
            evidence: limitations.slice(0, MAX_EVIDENCE),
          };
    }
  }
}

export function evaluateIntent(claims: readonly IntentClaim[], result: ScanResult): IntentClaimResult[] {
  return claims.map((claim) => evaluateClaim(claim, result));
}

export function buildIntentReport(
  claimResults: readonly IntentClaimResult[],
  subject: IntentReport["subject"],
  unstructuredCharacters: number,
  toolVersion: string,
  generatedAt: Date = new Date(),
): IntentReport {
  const body = {
    intentVersion: "1" as const,
    tool: { name: "codebase-doctor" as const, version: toolVersion },
    generatedAt: generatedAt.toISOString(),
    subject,
    summary: {
      claims: claimResults.length,
      verified: claimResults.filter((claim) => claim.status === "verified").length,
      violated: claimResults.filter((claim) => claim.status === "violated").length,
      undecided: claimResults.filter((claim) => claim.status === "undecided").length,
    },
    claims: [...claimResults],
    unstructuredCharacters,
  };
  return {
    ...body,
    digest: {
      algorithm: "sha256",
      value: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex"),
    },
  };
}

export function renderIntentText(report: IntentReport): string {
  const lines = [
    "Codebase Doctor Intent Verification",
    "===================================",
    "",
    `Subject: ${report.subject.path} · intent: ${report.subject.intentSource}`,
    "",
  ];
  for (const claim of report.claims) {
    lines.push(`${claim.status.toUpperCase().padEnd(9)} ${claim.id} (${claim.kind}) — ${claim.reason}`);
    for (const evidence of claim.evidence) lines.push(`          · ${evidence}`);
  }
  lines.push(
    "",
    `Summary: ${report.summary.verified} verified, ${report.summary.violated} violated, ` +
    `${report.summary.undecided} undecided of ${report.summary.claims} claim(s).`,
  );
  if (report.unstructuredCharacters > 0) {
    lines.push(
      `Note: ${report.unstructuredCharacters} character(s) of prose outside intent blocks were not ` +
      "interpreted — undeclared intent cannot be verified.",
    );
  }
  lines.push(
    report.summary.violated > 0
      ? "Exit code 1: at least one declared claim is violated by the evidence."
      : report.summary.undecided > 0
        ? "Exit code 0: no violation; undecided claims are never counted as verified."
        : "Exit code 0: every declared claim is verified.",
  );
  return `${lines.join("\n")}\n`;
}
