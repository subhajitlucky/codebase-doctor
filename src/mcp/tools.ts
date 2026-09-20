import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadBaseline } from "../core/baseline.js";
import { AUDIT_DOMAINS } from "../core/domain-coverage.js";
import { compareFindings } from "../core/findings.js";
import { auditCodebase, type AuditRequest } from "../core/scan.js";
import { coverageLimitations, verifyRepairs } from "../core/verify.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderTextReport } from "../reporters/text.js";
import { renderVerifyText } from "../reporters/verify.js";
import { VERSION } from "../version.js";
import { boundToolPayload } from "./payload.js";
import {
  AUDIT_TOOL_NAME,
  CAPABILITIES_TOOL_NAME,
  EXPLAIN_TOOL_NAME,
  parseAuditToolArgs,
  parseCapabilitiesToolArgs,
  parseExplainToolArgs,
  parseVerifyToolArgs,
  TOOL_DEFINITIONS,
  VERIFY_TOOL_NAME,
  type AuditToolArgs,
  type ExplainToolArgs,
  type VerifyToolArgs,
} from "./tool-schemas.js";

// Mirror the CLI defaults in src/commands/scan.ts; scan keeps them private.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FAIL_ON = "high";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

async function runBuiltInAudit(
  path: string | undefined,
  changed: boolean,
  base: string | undefined,
) {
  const request: AuditRequest = {
    root: path ?? process.cwd(),
    runChecks: false,
    format: "json",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    failOn: DEFAULT_FAIL_ON,
    includeDatabaseAudit: true,
    includeSecurityAudit: true,
    ...(changed ? { changed: true } : {}),
    ...(base === undefined ? {} : { baseRef: base }),
  };
  return auditCodebase(request);
}

/**
 * Run one read-only built-in audit through the public programmatic API and
 * return its rendered report inside a bounded payload.
 */
export async function handleAuditCodebase(args: AuditToolArgs): Promise<CallToolResult> {
  const result = await runBuiltInAudit(args.path, args.changed === true, args.base);
  const rendered = args.format === "summary"
    ? renderTextReport(result, { color: false, isTTY: false })
    : renderJsonReport(result);
  return textResult(boundToolPayload(rendered).text);
}

/**
 * Verify a prior baseline against a fresh read-only audit. Absence under
 * incomplete coverage stays unresolved; it is never reported as resolved.
 */
export async function handleVerifyChanges(args: VerifyToolArgs): Promise<CallToolResult> {
  const baseline = await loadBaseline(args.baseline);
  const result = await runBuiltInAudit(args.path, args.changed === true, args.base);
  const verification = verifyRepairs(baseline.findings, result);

  const rendered =
    args.format === "summary"
      ? renderVerifyText(verification)
      : JSON.stringify(
          { tool: { name: "codebase-doctor", version: VERSION }, ...verification },
          null,
          2,
        );

  return textResult(boundToolPayload(rendered).text);
}

/**
 * Return the full evidence, remediation, and verification command for one
 * finding selected by fingerprint or rule id.
 */
export async function handleExplainFinding(args: ExplainToolArgs): Promise<CallToolResult> {
  const result = await runBuiltInAudit(args.path, args.changed === true, args.base);
  const limitations = coverageLimitations(result);
  const matches = result.findings
    .filter((finding) =>
      args.fingerprint !== undefined
        ? finding.fingerprint === args.fingerprint
        : finding.ruleId === args.ruleId,
    )
    .sort(compareFindings);
  const finding = matches[0];

  const payload = {
    tool: { name: "codebase-doctor", version: VERSION },
    query: {
      ...(args.fingerprint === undefined ? {} : { fingerprint: args.fingerprint }),
      ...(args.ruleId === undefined ? {} : { ruleId: args.ruleId }),
      scope: result.auditScope.mode,
    },
    found: finding !== undefined,
    coverageComplete: limitations.length === 0,
    coverageLimitations: limitations,
    ...(finding === undefined ? {} : { finding }),
    note:
      finding === undefined
        ? "Not present in this scan. Absence is only a repair when coverage is complete and the finding came from a baseline."
        : "Full evidence for this finding. Repair externally, then verify with verify_changes against the baseline.",
  };

  return textResult(boundToolPayload(JSON.stringify(payload, null, 2)).text);
}

/** Describe registry metadata: tools, audit domains, and capability vocabulary. */
export function handleDescribeCapabilities(): CallToolResult {
  return textResult(
    JSON.stringify(
      {
        server: { name: "codebase-doctor", version: VERSION },
        transport: "stdio",
        tools: TOOL_DEFINITIONS.map(({ name, description }) => ({
          name,
          description,
        })),
        auditDomains: AUDIT_DOMAINS,
        doctorCapabilities: {
          vocabulary: ["filesystem:read", "process:execute", "network:access"],
          grantedByThisServer: {
            "filesystem:read": true,
            "process:execute": false,
            "network:access": false,
          },
          note:
            "The MCP surface is read-only and offline. It never enables " +
            "--run-checks validation commands or --with-database live catalog " +
            "access; run the CLI explicitly to grant those separately.",
        },
        usage:
          "Prefer audit_codebase with changed=true after edits and a full audit " +
          "at trust or release boundaries. After repairing findings, call " +
          "verify_changes with the saved baseline report; a baseline finding is " +
          "only resolved when it is absent and coverage completed. Use " +
          "explain_finding for full evidence and the verification command for one " +
          "finding. Inspect auditScope, sourceImpact, doctorRuns, coverage, and " +
          "findings; zero findings under partial, skipped, or not-selected " +
          "coverage is not a clean result.",
      },
      null,
      2,
    ),
  );
}

/** Map an unexpected failure to the house-prefixed actionable error result. */
export function errorToolResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `codebase-doctor: ${message}` }],
    isError: true,
  };
}

/** Dispatch a tools/call request by name; throws for unknown tool names. */
export async function handleToolCall(
  name: string,
  rawArguments: unknown,
): Promise<CallToolResult> {
  if (name === AUDIT_TOOL_NAME) {
    return handleAuditCodebase(parseAuditToolArgs(rawArguments));
  }
  if (name === VERIFY_TOOL_NAME) {
    return handleVerifyChanges(parseVerifyToolArgs(rawArguments));
  }
  if (name === EXPLAIN_TOOL_NAME) {
    return handleExplainFinding(parseExplainToolArgs(rawArguments));
  }
  if (name === CAPABILITIES_TOOL_NAME) {
    parseCapabilitiesToolArgs(rawArguments);
    return handleDescribeCapabilities();
  }
  throw new Error(
    `Unknown tool "${name}". Available tools: ${
      TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")
    }.`,
  );
}