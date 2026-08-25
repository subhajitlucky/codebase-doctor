import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUDIT_DOMAINS } from "../core/domain-coverage.js";
import { auditCodebase, type AuditRequest } from "../core/scan.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderTextReport } from "../reporters/text.js";
import { VERSION } from "../version.js";
import { boundToolPayload } from "./payload.js";
import {
  AUDIT_TOOL_NAME,
  CAPABILITIES_TOOL_NAME,
  parseAuditToolArgs,
  parseCapabilitiesToolArgs,
  TOOL_DEFINITIONS,
  type AuditToolArgs,
} from "./tool-schemas.js";

// Mirror the CLI defaults in src/commands/scan.ts; scan keeps them private.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FAIL_ON = "high";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Run one read-only built-in audit through the public programmatic API and
 * return its rendered report inside a bounded payload.
 */
export async function handleAuditCodebase(args: AuditToolArgs): Promise<CallToolResult> {
  const request: AuditRequest = {
    root: args.path ?? process.cwd(),
    runChecks: false,
    format: "json",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    failOn: DEFAULT_FAIL_ON,
    includeDatabaseAudit: true,
    includeSecurityAudit: true,
    ...(args.changed === true ? { changed: true } : {}),
    ...(args.base === undefined ? {} : { baseRef: args.base }),
  };
  const result = await auditCodebase(request);
  const rendered = args.format === "summary"
    ? renderTextReport(result, { color: false, isTTY: false })
    : renderJsonReport(result);
  return textResult(boundToolPayload(rendered).text);
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
          "at trust or release boundaries. Inspect auditScope, sourceImpact, " +
          "doctorRuns, coverage, and findings; zero findings under partial, " +
          "skipped, or not-selected coverage is not a clean result.",
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