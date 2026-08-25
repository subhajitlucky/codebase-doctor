import { describe, expect, it } from "vitest";
import {
  AUDIT_TOOL_NAME,
  CAPABILITIES_TOOL_NAME,
  parseAuditToolArgs,
  parseCapabilitiesToolArgs,
  TOOL_DEFINITIONS,
} from "../../../src/mcp/tool-schemas.js";

describe("mcp tool definitions", () => {
  it("advertises the read-only audit and capability tools", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      AUDIT_TOOL_NAME,
      CAPABILITIES_TOOL_NAME,
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(typeof tool.description).toBe("string");
    }
  });

  it("maps the audit tool schema onto the existing CLI flags", () => {
    const auditTool = TOOL_DEFINITIONS.find((tool) => tool.name === AUDIT_TOOL_NAME);
    const auditProperties = auditTool?.inputSchema.properties;
    expect(auditTool).toBeDefined();
    expect(Object.keys(auditProperties ?? {})).toEqual([
      "path",
      "format",
      "changed",
      "base",
    ]);
    expect(auditTool?.inputSchema.required).toEqual([]);
    expect(auditProperties?.format).toMatchObject({
      enum: ["json", "summary"],
    });
    expect(auditTool?.inputSchema.additionalProperties).toBe(false);
  });
});

describe("audit_codebase argument parsing", () => {
  it("defaults to the current working directory and json format", () => {
    expect(parseAuditToolArgs(undefined)).toEqual({ format: "json" });
    expect(parseAuditToolArgs({})).toEqual({ format: "json" });
  });

  it("keeps provided path, changed, and base passthrough values", () => {
    expect(
      parseAuditToolArgs({
        path: "/tmp/repo",
        format: "summary",
        changed: true,
        base: "main",
      }),
    ).toEqual({
      path: "/tmp/repo",
      format: "summary",
      changed: true,
      base: "main",
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "{}"],
  ])("rejects %s arguments", (_label, input) => {
    expect(() => parseAuditToolArgs(input)).toThrow(/expected a JSON object/u);
  });

  it("rejects unsupported argument names with the supported list", () => {
    expect(() => parseAuditToolArgs({ runChecks: true })).toThrow(/runChecks/u);
    expect(() => parseAuditToolArgs({ runChecks: true })).toThrow(/base, changed, format, path/u);
  });

  it("rejects an invalid format value", () => {
    expect(() => parseAuditToolArgs({ format: "sarif" })).toThrow(
      /expected "json" or "summary"/u,
    );
  });

  it("rejects --base without --changed like the CLI", () => {
    expect(() => parseAuditToolArgs({ base: "main" })).toThrow(
      /--base option requires --changed/u,
    );
  });

  it("rejects an empty base reference like the CLI", () => {
    expect(() => parseAuditToolArgs({ changed: true, base: "  " })).toThrow(
      /non-empty string/u,
    );
  });

  it.each([
    ["path", { path: 42 }],
    ["changed", { changed: "yes" }],
    ["base", { changed: true, base: 7 }],
  ])("rejects a non-string or non-boolean %s value", (key, input) => {
    expect(() => parseAuditToolArgs(input)).toThrow(new RegExp(key, "u"));
  });
});

describe("describe_capabilities argument parsing", () => {
  it("accepts absent or empty arguments only", () => {
    expect(() => parseCapabilitiesToolArgs(undefined)).not.toThrow();
    expect(() => parseCapabilitiesToolArgs({})).not.toThrow();
    expect(() => parseCapabilitiesToolArgs({ verbose: true })).toThrow(
      /expected no arguments/u,
    );
  });
});