import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../../src/version.js";
import {
  errorToolResult,
  handleAuditCodebase,
  handleDescribeCapabilities,
  handleExplainFinding,
  handleToolCall,
  handleVerifyChanges,
} from "../../../src/mcp/tools.js";
import { MAX_TOOL_PAYLOAD_BYTES } from "../../../src/mcp/payload.js";

const repositoryRoot = process.cwd();
const fixture = (name: string) =>
  resolve(repositoryRoot, "test", "fixtures", name);

function textOf(result: CallToolResult): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("audit_codebase tool handler", () => {
  it(
    "returns the schema-1 JSON report for a real fixture audit",
    { timeout: 30_000 },
    async () => {
      const result = await handleAuditCodebase({
        path: fixture("node-pass"),
        format: "json",
      });
      const text = textOf(result);
      const report = JSON.parse(text) as { schemaVersion: string; findings: unknown[] };

      expect(report.schemaVersion).toBe("1");
      expect(Array.isArray(report.findings)).toBe(true);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
        MAX_TOOL_PAYLOAD_BYTES,
      );
    },
  );

  it(
    "renders the deterministic text report for the summary format",
    { timeout: 30_000 },
    async () => {
      const result = await handleAuditCodebase({
        path: fixture("node-pass"),
        format: "summary",
      });
      expect(textOf(result)).toContain("Codebase Doctor");
    },
  );
});

describe("describe_capabilities tool handler", () => {
  it("describes tools, domains, and never-granted permissions", () => {
    const result = handleDescribeCapabilities();
    const capabilities = JSON.parse(textOf(result)) as {
      server: { name: string; version: string };
      transport: string;
      tools: { name: string }[];
      auditDomains: string[];
      doctorCapabilities: {
        vocabulary: string[];
        grantedByThisServer: Record<string, boolean>;
      };
    };

    expect(capabilities.server).toEqual({ name: "codebase-doctor", version: VERSION });
    expect(capabilities.transport).toBe("stdio");
    expect(capabilities.tools.map((tool) => tool.name)).toEqual([
      "audit_codebase",
      "describe_capabilities",
      "verify_changes",
      "explain_finding",
    ]);
    expect(capabilities.auditDomains).toHaveLength(9);
    expect(capabilities.doctorCapabilities.grantedByThisServer).toEqual({
      "filesystem:read": true,
      "process:execute": false,
      "network:access": false,
    });
  });
});

describe("tool dispatch", () => {
  it("routes known tool names to their handlers", async () => {
    const routed = await handleToolCall("describe_capabilities", {});
    expect(textOf(routed)).toContain(`"version": "${VERSION}"`);
  });

  it("rejects unknown tool names with the available list", async () => {
    await expect(handleToolCall("unknown_tool", {})).rejects.toThrow(
      /Unknown tool "unknown_tool".*audit_codebase.*describe_capabilities/us,
    );
  });

  it("propagates argument validation failures before auditing", async () => {
    await expect(
      handleToolCall("audit_codebase", { base: "main" }),
    ).rejects.toThrow(/--base option requires --changed/u);
  });
});

describe("verify_changes tool handler", () => {
  it(
    "verifies a baseline report against a fresh audit",
    { timeout: 60_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codebase-doctor-mcp-verify-"));
      const baselinePath = join(directory, "baseline.json");
      try {
        await writeFile(
          baselinePath,
          JSON.stringify({
            schemaVersion: "1",
            tool: { name: "codebase-doctor", version: VERSION },
            findings: [],
          }),
          "utf8",
        );

        const result = await handleVerifyChanges({
          path: fixture("node-pass"),
          baseline: baselinePath,
          format: "json",
        });
        const verification = JSON.parse(textOf(result)) as {
          schemaVersion: string;
          counts: Record<string, number>;
          coverageComplete: boolean;
        };

        expect(verification.schemaVersion).toBe("1");
        expect(typeof verification.coverageComplete).toBe("boolean");
        expect(verification.counts).toMatchObject({
          resolved: 0,
          unchanged: 0,
          unresolved: 0,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it(
    "reports baseline absence honestly as resolved or unresolved",
    { timeout: 60_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codebase-doctor-mcp-verify-"));
      const baselinePath = join(directory, "baseline.json");
      try {
        await writeFile(
          baselinePath,
          JSON.stringify({
            schemaVersion: "1",
            tool: { name: "codebase-doctor", version: VERSION },
            findings: [
              { fingerprint: "deadbeefdeadbeef", severity: "high", ruleId: "synthetic" },
            ],
          }),
          "utf8",
        );

        const result = await handleVerifyChanges({
          path: fixture("node-pass"),
          baseline: baselinePath,
          format: "summary",
        });
        const text = textOf(result);

        expect(text).toMatch(/unresolved=1|resolved=1/u);
        expect(text).toContain("Codebase Doctor Verify");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("explain_finding tool handler", () => {
  it(
    "explains a matching finding or reports honest absence",
    { timeout: 60_000 },
    async () => {
      const audit = JSON.parse(
        textOf(await handleAuditCodebase({ path: fixture("node-fail"), format: "json" })),
      ) as { findings: { fingerprint: string; ruleId: string }[] };

      if (audit.findings.length > 0) {
        const first = audit.findings[0]!;
        const explained = JSON.parse(
          textOf(
            await handleExplainFinding({
              path: fixture("node-fail"),
              fingerprint: first.fingerprint,
            }),
          ),
        ) as { found: boolean; finding: { ruleId: string } };
        expect(explained.found).toBe(true);
        expect(explained.finding.ruleId).toBe(first.ruleId);
      } else {
        const explained = JSON.parse(
          textOf(await handleExplainFinding({ path: fixture("node-fail"), ruleId: "missing" })),
        ) as { found: boolean; note: string };
        expect(explained.found).toBe(false);
        expect(explained.note).toContain("coverage");
      }
    },
  );

  it(
    "reports absence for an unknown fingerprint",
    { timeout: 60_000 },
    async () => {
      const explained = JSON.parse(
        textOf(
          await handleExplainFinding({
            path: fixture("node-pass"),
            fingerprint: "ffffffffffffffff",
          }),
        ),
      ) as { found: boolean; note: string };

      expect(explained.found).toBe(false);
      expect(explained.note).toContain("coverage is complete");
    },
  );
});

describe("error mapping", () => {
  it("prefixes operational failures with the house error marker", () => {
    const result = errorToolResult(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("codebase-doctor: boom");
  });

  it("stringifies non-error throwables", () => {
    expect(textOf(errorToolResult("plain"))).toBe("codebase-doctor: plain");
  });
});