import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { ScanResult } from "../core/normalize.js";
import { scoreScanResult } from "../core/score.js";
import { coverageLimitations } from "../core/verify.js";
import { canonicalJson } from "../receipts/receipt.js";

export const PHEROMONE_VERSION = "1";

export interface PheromonePattern {
  ruleId: string;
  severity: string;
  count: number;
}

export interface PheromoneSignal {
  pheromoneVersion: string;
  tool: { name: string; version: string };
  emittedAt: string;
  scope: {
    auditScope: string;
    score: number;
    coverageComplete: boolean;
    suppressed: number;
  };
  patterns: PheromonePattern[];
  digest: { algorithm: "sha256"; value: string };
  signature?: { algorithm: "ed25519"; publicKey: string; value: string };
}

type SignalBody = Omit<PheromoneSignal, "digest" | "signature">;

export interface PheromoneIndexPattern {
  ruleId: string;
  severity: string;
  signals: number;
  occurrences: number;
}

export interface PheromoneIndex {
  indexVersion: string;
  generatedAt: string;
  minSignals: number;
  signals: { total: number; verified: number; rejected: number };
  patterns: PheromoneIndexPattern[];
  digest: { algorithm: "sha256"; value: string };
}

type IndexBody = Omit<PheromoneIndex, "digest">;

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];

function digestOf(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

/**
 * Build a pheromone signal: a privacy-bounded summary of an audit that can be
 * shared without revealing anything about the codebase. Only rule ids,
 * severities, and counts leave the machine — never paths, fingerprints,
 * source text, secrets, or the repository name.
 */
export function buildPheromone(
  result: ScanResult,
  options: { emittedAt?: Date; privateKeyPem?: string } = {},
): PheromoneSignal {
  const counts = new Map<string, PheromonePattern>();
  for (const finding of result.findings) {
    const existing = counts.get(finding.ruleId);
    if (existing === undefined) {
      counts.set(finding.ruleId, {
        ruleId: finding.ruleId,
        severity: finding.severity,
        count: 1,
      });
    } else {
      existing.count += 1;
      if (SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(existing.severity)) {
        existing.severity = finding.severity;
      }
    }
  }

  const body: SignalBody = {
    pheromoneVersion: PHEROMONE_VERSION,
    tool: { name: result.tool.name, version: result.tool.version },
    emittedAt: (options.emittedAt ?? new Date()).toISOString(),
    scope: {
      auditScope: result.auditScope.mode,
      score: scoreScanResult(result).value,
      coverageComplete: coverageLimitations(result).length === 0,
      suppressed: result.suppressed.length,
    },
    patterns: [...counts.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  };

  const signal: PheromoneSignal = { ...body, digest: { algorithm: "sha256", value: digestOf(body) } };
  if (options.privateKeyPem !== undefined) {
    const privateKey = createPrivateKey(options.privateKeyPem);
    const publicKey = createPublicKey(privateKey);
    signal.signature = {
      algorithm: "ed25519",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      value: sign(null, Buffer.from(canonicalJson(body), "utf8"), privateKey).toString("base64"),
    };
  }
  return signal;
}

export function serializePheromone(signal: PheromoneSignal): string {
  return `${JSON.stringify(signal, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PheromoneVerification {
  valid: boolean;
  reasons: string[];
}

export function verifyPheromone(value: unknown): PheromoneVerification {
  const reasons: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, reasons: ["signal is not a JSON object"] };
  }
  if (value.pheromoneVersion !== PHEROMONE_VERSION) {
    reasons.push(`unsupported pheromoneVersion: ${String(value.pheromoneVersion)}`);
  }
  const { digest, signature, ...body } = value as Partial<PheromoneSignal>;
  if (!isRecord(digest) || digest.algorithm !== "sha256" || typeof digest.value !== "string") {
    reasons.push("missing or invalid digest");
  } else if (digestOf(body) !== digest.value) {
    reasons.push("digest mismatch: the signal was modified after emission");
  }

  if (signature !== undefined) {
    if (
      !isRecord(signature) ||
      signature.algorithm !== "ed25519" ||
      typeof signature.value !== "string" ||
      typeof signature.publicKey !== "string"
    ) {
      reasons.push("invalid signature block");
    } else if (reasons.length === 0) {
      try {
        const valid = verify(
          null,
          Buffer.from(canonicalJson(body), "utf8"),
          createPublicKey(signature.publicKey),
          Buffer.from(signature.value, "base64"),
        );
        if (!valid) reasons.push("signature does not match the signal body");
      } catch {
        reasons.push("signature could not be verified");
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

export interface MergeOptions {
  minSignals?: number;
  generatedAt?: Date;
  allowInvalid?: boolean;
}

export interface MergeResult {
  index?: PheromoneIndex;
  rejected: { index: number; reasons: string[] }[];
  total: number;
}

/**
 * Merge verified signals into a public pattern index. Signals below the
 * k-anonymity threshold are excluded so rare patterns cannot be attributed
 * back to a single repository. Invalid signals are rejected, never merged.
 */
export function mergePheromones(
  values: readonly unknown[],
  options: MergeOptions = {},
): MergeResult {
  const minSignals = options.minSignals ?? 1;
  const rejected: { index: number; reasons: string[] }[] = [];
  const accepted: PheromoneSignal[] = [];

  for (const [index, value] of values.entries()) {
    const verification = verifyPheromone(value);
    if (!verification.valid) {
      rejected.push({ index, reasons: verification.reasons });
      continue;
    }
    accepted.push(value as PheromoneSignal);
  }

  if (rejected.length > 0 && options.allowInvalid !== true) {
    return { rejected, total: values.length };
  }

  const byRule = new Map<string, PheromoneIndexPattern>();
  for (const signal of accepted) {
    for (const pattern of signal.patterns) {
      const existing = byRule.get(pattern.ruleId);
      if (existing === undefined) {
        byRule.set(pattern.ruleId, {
          ruleId: pattern.ruleId,
          severity: pattern.severity,
          signals: 1,
          occurrences: pattern.count,
        });
      } else {
        existing.signals += 1;
        existing.occurrences += pattern.count;
        if (SEVERITY_ORDER.indexOf(pattern.severity) > SEVERITY_ORDER.indexOf(existing.severity)) {
          existing.severity = pattern.severity;
        }
      }
    }
  }

  const patterns = [...byRule.values()]
    .filter((pattern) => pattern.signals >= minSignals)
    .sort((left, right) =>
      right.signals - left.signals ||
      right.occurrences - left.occurrences ||
      left.ruleId.localeCompare(right.ruleId)
    );

  const body: IndexBody = {
    indexVersion: "1",
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    minSignals,
    signals: { total: values.length, verified: accepted.length, rejected: rejected.length },
    patterns,
  };

  return {
    index: { ...body, digest: { algorithm: "sha256", value: digestOf(body) } },
    rejected,
    total: values.length,
  };
}

export function renderIndexText(index: PheromoneIndex): string {
  const lines = [
    "Pheromone Pattern Index",
    "=======================",
    "",
    `Signals: ${index.signals.verified} verified, ${index.signals.rejected} rejected of ${index.signals.total}`,
    `k-anonymity: patterns observed in fewer than ${index.minSignals} signal(s) are excluded`,
    "",
  ];
  if (index.patterns.length === 0) {
    lines.push("No pattern met the k-anonymity threshold.");
  } else {
    lines.push("PATTERN".padEnd(52) + "SEVERITY".padEnd(10) + "SIGNALS  OCCURRENCES");
    for (const pattern of index.patterns) {
      lines.push(
        pattern.ruleId.padEnd(52) +
        pattern.severity.padEnd(10) +
        String(pattern.signals).padStart(7) +
        String(pattern.occurrences).padStart(13),
      );
    }
  }
  lines.push(
    "",
    "Signals never contain paths, fingerprints, source text, secrets, or repository names.",
  );
  return `${lines.join("\n")}\n`;
}
