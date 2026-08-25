import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  boundToolPayload,
  cutUtf8Safe,
  MAX_TOOL_PAYLOAD_BYTES,
} from "../../../src/mcp/payload.js";

function oversizedReport(findings: number, findingBytes: number): string {
  const filler = "x".repeat(findingBytes);
  return JSON.stringify(
    {
      schemaVersion: 1,
      root: "/tmp/example",
      findings: Array.from({ length: findings }, (_, index) => ({
        ruleId: `example/rule-${index}`,
        evidence: [{ type: "observation", detail: `${filler}-${index}` }],
      })),
      doctorRuns: [],
    },
    null,
    2,
  );
}

describe("boundToolPayload", () => {
  it("passes payloads within the budget through untouched", () => {
    const text = JSON.stringify({ schemaVersion: 1, findings: [] }, null, 2);
    expect(boundToolPayload(text)).toEqual({ text });
  });

  it("prunes whole JSON findings instead of breaking validity", () => {
    const original = oversizedReport(80, 4_000);
    expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(
      MAX_TOOL_PAYLOAD_BYTES,
    );
    const bounded = boundToolPayload(original);

    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_PAYLOAD_BYTES,
    );
    const parsed = JSON.parse(bounded.text) as {
      truncated?: boolean;
      note?: string;
      findings: unknown[];
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toMatch(/\d+ of 80 findings were omitted/u);
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(parsed.findings.length).toBeLessThan(80);
  });

  it("is deterministic for identical inputs", () => {
    const original = oversizedReport(64, 4_000);
    expect(boundToolPayload(original)).toEqual(boundToolPayload(original));
  });

  it("keeps one finding when a tiny budget forces deep pruning", () => {
    const original = oversizedReport(3, 400);
    const bounded = boundToolPayload(original, 900);
    const parsed = JSON.parse(bounded.text) as { findings: unknown[] };
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(900);
    expect(parsed.findings.length).toBe(1);
  });

  it("falls back to a truncated envelope when pruning cannot fit", () => {
    const original = JSON.stringify({
      schemaVersion: 1,
      findings: [{ detail: "y".repeat(4_000) }],
    });
    const bounded = boundToolPayload(original, 256);
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(256);
    const parsed = JSON.parse(bounded.text) as { truncated?: boolean; note?: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toMatch(/even without findings/u);
  });

  it("cuts non-JSON payloads on a safe UTF-8 boundary with a note", () => {
    const original = "z".repeat(MAX_TOOL_PAYLOAD_BYTES + 5_000);
    const bounded = boundToolPayload(original);
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_PAYLOAD_BYTES,
    );
    expect(bounded.note).toMatch(/\[note\] Truncated/u);
    expect(bounded.text.endsWith(bounded.note ?? "")).toBe(true);
  });

  it("never splits multi-byte characters when cutting text", () => {
    const original = "\u{1F600}".repeat(100);
    const cut = cutUtf8Safe(original, 61);
    expect(cut.includes("\uFFFD")).toBe(false);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(61);
  });
});