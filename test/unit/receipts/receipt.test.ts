import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DoctorResult, RegisteredDoctorResult } from "../../../src/core/doctor.js";
import type { DomainCoverage } from "../../../src/core/domain-coverage.js";
import { createFingerprint, type Finding } from "../../../src/core/findings.js";
import { normalizeScanResult, type ScanResult } from "../../../src/core/normalize.js";
import {
  buildReceipt,
  canonicalJson,
  receiptDigest,
  serializeReceipt,
  verifyReceipt,
} from "../../../src/receipts/receipt.js";
import { fullAuditScope } from "../../../src/scope/planner.js";

function finding(): Finding {
  return {
    ruleId: "fixture/high",
    doctorId: "fixture",
    severity: "high",
    confidence: "high",
    category: "test",
    title: "High finding",
    message: "High message",
    evidence: [{ type: "observation", detail: "high" }],
    fingerprint: createFingerprint({
      doctorId: "fixture",
      ruleId: "fixture/high",
      identity: "high",
    }),
  };
}

const incompleteCoverage: DomainCoverage[] = [
  {
    domain: "security",
    applicability: "unknown",
    status: "unsupported",
    coverageComplete: false,
    evidence: [],
    modules: [],
    limitations: ["General security analysis is not implemented."],
  },
];

function result(): ScanResult {
  const registered: RegisteredDoctorResult = {
    doctorId: "fixture",
    result: {
      status: "completed",
      durationMs: 0,
      findings: [finding()],
    } satisfies DoctorResult,
  };
  return normalizeScanResult("/repo", [], fullAuditScope(), [registered], [], incompleteCoverage);
}

describe("coverage receipts", () => {
  it("canonicalizes JSON deterministically with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1 }));
  });

  it("builds a receipt whose digest covers the canonical body", () => {
    const receipt = buildReceipt(result(), { issuedAt: new Date("2026-10-09T00:00:00Z") });
    const { digest, signature, ...body } = receipt;

    expect(signature).toBeUndefined();
    expect(digest).toEqual({ algorithm: "sha256", value: receiptDigest(body) });
    expect(receipt.findings.total).toBe(1);
    expect(receipt.findings.bySeverity.high).toBe(1);
    expect(receipt.findings.fingerprints).toHaveLength(1);
    expect(receipt.coverage.complete).toBe(false);
    expect(receipt.coverage.limitations).toContain("security: unsupported");

    const verification = verifyReceipt(JSON.parse(serializeReceipt(receipt)));
    expect(verification.valid).toBe(true);
    expect(verification.summary).toContain("integrity: digest verified");
  });

  it("detects a modified receipt body", () => {
    const receipt = buildReceipt(result());
    const tampered = { ...receipt, score: { value: 100, band: "green" } };

    const verification = verifyReceipt(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.reasons).toContain(
      "digest mismatch: the receipt body was modified after issuance",
    );
  });

  it("signs and verifies with an Ed25519 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const receipt = buildReceipt(result(), {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });

    expect(receipt.signature?.algorithm).toBe("ed25519");
    expect(verifyReceipt(receipt).valid).toBe(true);

    const forged = {
      ...receipt,
      signature: { ...receipt.signature, value: Buffer.from("nope").toString("base64") },
    };
    const verification = verifyReceipt(forged);
    expect(verification.valid).toBe(false);
    expect(verification.reasons).toContain("signature does not match the receipt body");
  });

  it("rejects unknown receipt versions", () => {
    const receipt = buildReceipt(result());
    const verification = verifyReceipt({ ...receipt, receiptVersion: "99" });
    expect(verification.valid).toBe(false);
    expect(verification.reasons).toContain("unsupported receiptVersion: 99");
  });
});
