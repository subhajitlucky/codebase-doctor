import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const AUDIT_TOOL_NAME = "audit_codebase";
export const CAPABILITIES_TOOL_NAME = "describe_capabilities";

export type McpAuditFormat = "json" | "summary";

const MCP_AUDIT_FORMATS = new Set<McpAuditFormat>(["json", "summary"]);

const AUDIT_TOOL_ARGUMENTS = new Set(["path", "format", "changed", "base"]);

export interface AuditToolArgs {
  path?: string;
  format: McpAuditFormat;
  changed?: boolean;
  base?: string;
}

/**
 * JSON Schema definitions advertised through the MCP tools/list response.
 * They are plain data so clients and tests can inspect them without running
 * server logic.
 */
export const TOOL_DEFINITIONS: readonly Tool[] = [
  {
    name: AUDIT_TOOL_NAME,
    description:
      "Run the full built-in Codebase Doctor audit on a repository and return " +
      "the evidence-backed report. Read-only and offline by default; it never " +
      "enables validation commands (--run-checks) or live database access " +
      "(--with-database).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository path to audit. Defaults to the server working directory.",
        },
        format: {
          type: "string",
          enum: ["json", "summary"],
          description:
            'Report rendering: "json" returns the schema-version-1 JSON report; ' +
            '"summary" returns the deterministic text report.',
        },
        changed: {
          type: "boolean",
          description:
            "Audit Git changes (staged, unstaged, untracked, and branch work) " +
            "and their selected scope instead of the full repository.",
        },
        base: {
          type: "string",
          description:
            "Git ref to compare against from the merge base; requires changed. " +
            "Mirrors the CLI --base option.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: {
      title: "Audit a codebase",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: CAPABILITIES_TOOL_NAME,
    description:
      "Describe this MCP server: available tools, the nine audit domains in " +
      "the domainCoverage inventory, the Doctor capability vocabulary, and the " +
      "permissions this server never grants.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      title: "Describe Codebase Doctor capabilities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function requireObject(input: unknown, toolName: string): Map<string, unknown> {
  if (input === undefined) return new Map();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`Invalid ${toolName} arguments: expected a JSON object.`);
  }
  return new Map(Object.entries(input));
}

function readString(
  args: Map<string, unknown>,
  key: string,
  toolName: string,
): string | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid ${toolName} argument "${key}": expected a non-empty string.`,
    );
  }
  return value;
}

function readBoolean(
  args: Map<string, unknown>,
  key: string,
  toolName: string,
): boolean | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${toolName} argument "${key}": expected a boolean.`);
  }
  return value;
}

function readFormat(args: Map<string, unknown>): McpAuditFormat {
  const value = args.get("format");
  if (value === undefined) return "json";
  if (typeof value !== "string" || !MCP_AUDIT_FORMATS.has(value as McpAuditFormat)) {
    throw new Error(
      'Invalid audit_codebase argument "format": expected "json" or "summary".',
    );
  }
  return value as McpAuditFormat;
}

/**
 * Validate and normalize raw audit_codebase arguments with the same rules as
 * the CLI flags they mirror: --base requires --changed, and an explicit base
 * reference must be non-empty.
 */
export function parseAuditToolArgs(input: unknown): AuditToolArgs {
  const args = requireObject(input, AUDIT_TOOL_NAME);
  for (const key of args.keys()) {
    if (!AUDIT_TOOL_ARGUMENTS.has(key)) {
      throw new Error(
        `Invalid ${AUDIT_TOOL_NAME} argument "${key}": supported arguments ` +
          `are ${[...AUDIT_TOOL_ARGUMENTS].sort().join(", ")}.`,
      );
    }
  }
  const changed = readBoolean(args, "changed", AUDIT_TOOL_NAME) === true;
  const base = readString(args, "base", AUDIT_TOOL_NAME);
  if (base !== undefined && !changed) {
    throw new Error("The --base option requires --changed.");
  }
  const path = readString(args, "path", AUDIT_TOOL_NAME);
  const format = readFormat(args);
  return {
    ...(path === undefined ? {} : { path }),
    format,
    ...(changed ? { changed: true } : {}),
    ...(base === undefined ? {} : { base }),
  };
}

/** Validate raw describe_capabilities arguments; only an empty set is accepted. */
export function parseCapabilitiesToolArgs(input: unknown): void {
  const args = requireObject(input, CAPABILITIES_TOOL_NAME);
  if (args.size > 0) {
    throw new Error(
      `Invalid ${CAPABILITIES_TOOL_NAME} arguments: expected no arguments.`,
    );
  }
}