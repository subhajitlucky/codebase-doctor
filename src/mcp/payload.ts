/**
 * Bounded MCP tool payloads. Oversized reports are truncated deterministically
 * with an explicit note so agents can never mistake silent truncation for a
 * complete result. The default cap is about 50 KB.
 */
export const MAX_TOOL_PAYLOAD_BYTES = 50 * 1024;

export interface BoundedPayload {
  text: string;
  note?: string;
}

interface JsonReportPruning {
  total: number;
  reportBytes: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Cut UTF-8 text at a byte budget without splitting a multi-byte sequence. */
export function cutUtf8Safe(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function parseJsonObject(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function findingsOf(report: Record<string, unknown>): readonly unknown[] {
  const findings = report["findings"];
  return Array.isArray(findings) ? findings : [];
}

function serializeWithFindings(
  report: Record<string, unknown>,
  kept: number,
  pruning: JsonReportPruning,
): string {
  const omitted = pruning.total - kept;
  const note = omitted === 0
    ? `The serialized report was ${pruning.reportBytes} bytes and exceeded the ` +
      `${MAX_TOOL_PAYLOAD_BYTES} byte limit; compact JSON without indentation is shown.`
    : `Truncated for this tool response: ${omitted} of ${pruning.total} findings were ` +
      `omitted because the serialized report was ${pruning.reportBytes} bytes and the ` +
      `limit is ${MAX_TOOL_PAYLOAD_BYTES} bytes. Run codebase-doctor audit . --json for ` +
      "the complete report.";
  const bounded = {
    ...report,
    findings: findingsOf(report).slice(0, kept),
    truncated: true,
    note,
  };
  return JSON.stringify(bounded);
}

function boundJsonReport(
  report: Record<string, unknown>,
  maxBytes: number,
): BoundedPayload {
  const pruning: JsonReportPruning = {
    total: findingsOf(report).length,
    reportBytes: byteLength(JSON.stringify(report)),
  };
  let kept = pruning.total;
  while (kept > 0) {
    const candidate = serializeWithFindings(report, kept, pruning);
    if (byteLength(candidate) <= maxBytes) {
      return { text: candidate };
    }
    kept = Math.floor(kept / 2);
  }
  const emptyCandidate = serializeWithFindings(report, 0, pruning);
  if (byteLength(emptyCandidate) <= maxBytes) {
    return { text: emptyCandidate };
  }
  const envelopeNote =
    `Truncated for this tool response: even without findings the report is ` +
    `${pruning.reportBytes} bytes and the limit is ${maxBytes} bytes. Run ` +
    "codebase-doctor audit . --json directly for the complete report.";
  const envelope = JSON.stringify({ truncated: true, note: envelopeNote });
  if (byteLength(envelope) <= maxBytes) {
    return { text: envelope };
  }
  return { text: cutUtf8Safe(envelope, maxBytes), note: envelopeNote };
}

function boundTextPayload(text: string, maxBytes: number): BoundedPayload {
  const note =
    `[note] Truncated for this tool response: output was ${byteLength(text)} bytes ` +
    `and the limit is ${maxBytes} bytes. Run codebase-doctor audit . --json directly ` +
    "for the complete report.";
  const budget = maxBytes - byteLength(note) - 2;
  const cut = cutUtf8Safe(text, Math.max(budget, 0));
  return { text: `${cut}\n\n${note}`, note };
}

/**
 * Bound any tool payload to the byte budget. JSON reports keep valid JSON by
 * omitting whole findings; other payloads are cut on a safe UTF-8 boundary.
 */
export function boundToolPayload(
  text: string,
  maxBytes: number = MAX_TOOL_PAYLOAD_BYTES,
): BoundedPayload {
  if (byteLength(text) <= maxBytes) return { text };
  const report = parseJsonObject(text);
  if (report === undefined) return boundTextPayload(text, maxBytes);
  return boundJsonReport(report, maxBytes);
}