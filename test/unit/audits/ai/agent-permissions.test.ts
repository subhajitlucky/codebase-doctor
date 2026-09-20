import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createAgentSurfaceDoctor } from "../../../../src/audits/ai/agent-surface/doctor.js";
import { AGENT_SURFACE_DOCTOR_ID } from "../../../../src/audits/ai/agent-surface/mcp-config.js";
import {
  analyzeInstructionFlags,
  analyzePermissionConfig,
  isInstructionFile,
  permissionConfigKind,
} from "../../../../src/audits/ai/agent-surface/permissions.js";
import { analyzeSkillFile } from "../../../../src/audits/ai/agent-surface/skills.js";
import { fullAuditScope } from "../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../src/workspace/types.js";

function snapshotWith(paths: readonly string[]): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file" as const, size: 300 })),
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

describe("agent permission configuration analysis", () => {
  it("classifies documented permission config paths", () => {
    expect(permissionConfigKind(".claude/settings.json")).toBe("claude");
    expect(permissionConfigKind(".claude/settings.local.json")).toBe("claude");
    expect(permissionConfigKind(".vscode/settings.json")).toBe("vscode");
    expect(permissionConfigKind(".aider.conf.yml")).toBe("aider");
    expect(permissionConfigKind("settings.json")).toBeUndefined();
    expect(permissionConfigKind("src/settings.json")).toBeUndefined();
  });

  it("flags bypass mode, unscoped allow rules, and hook commands", () => {
    const analysis = analyzePermissionConfig(
      ".claude/settings.json",
      "claude",
      JSON.stringify({
        permissions: {
          defaultMode: "bypassPermissions",
          allow: ["Bash(npm run test:*)", "Bash(*)", "Read"],
        },
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo audited" }] },
          ],
        },
      }),
    );

    expect(analysis.status).toBe("supported");
    expect(analysis.matches.map((entry) => entry.ruleId).sort()).toEqual([
      "ai/agent-surface/broad-permission-allow",
      "ai/agent-surface/hook-shell-command",
      "ai/agent-surface/permission-bypass",
    ]);
    expect(analysis.matches.find((entry) => entry.ruleId.endsWith("permission-bypass"))?.severity)
      .toBe("high");
    const evidence = analysis.matches.map((entry) =>
      entry.evidence.type === "file" ? entry.evidence.detail : ""
    );
    expect(evidence.join(" ")).not.toContain("echo audited");
  });

  it("accepts scoped allow rules and non-command hooks", () => {
    const analysis = analyzePermissionConfig(
      ".claude/settings.json",
      "claude",
      JSON.stringify({
        permissions: { defaultMode: "acceptEdits", allow: ["Bash(npm run lint:*)"] },
      }),
    );
    expect(analysis.matches).toEqual([]);
    expect(analysis.status).toBe("supported");
  });

  it("flags workspace auto-approve and Aider auto-confirm", () => {
    const vscode = analyzePermissionConfig(
      ".vscode/settings.json",
      "vscode",
      JSON.stringify({ "chat.tools.autoApprove": true }),
    );
    expect(vscode.matches).toEqual([
      expect.objectContaining({ ruleId: "ai/agent-surface/permission-bypass", severity: "high" }),
    ]);

    const aider = analyzePermissionConfig(".aider.conf.yml", "aider", "yes-always: true\n");
    expect(aider.matches).toEqual([
      expect.objectContaining({ ruleId: "ai/agent-surface/permission-bypass" }),
    ]);
    expect(aider.matches[0]?.evidence.type === "file" && aider.matches[0].evidence.detail)
      .toContain("yes-always");
  });

  it("reports invalid permission configuration as a limitation", () => {
    const analysis = analyzePermissionConfig(".claude/settings.json", "claude", "{not json");
    expect(analysis.status).toBe("invalid");
    expect(analysis.limitations[0]).toContain("JSON");
  });
});

describe("agent instruction flags", () => {
  it("flags bypass flags inside code content only", () => {
    const content = [
      "# Agent guide",
      "",
      "Run the agent normally.",
      "",
      "```sh",
      "claude --dangerously-skip-permissions",
      "```",
      "",
      "Avoid `--yolo` in shared workspaces.",
      "",
      "A prose warning about --dangerously-skip-permissions is not a command.",
      "",
    ].join("\n");
    const analysis = analyzeInstructionFlags("AGENTS.md", content);
    expect(analysis.matches.map((entry) => entry.identity).sort()).toEqual([
      "instruction-flag:--dangerously-skip-permissions",
      "instruction-flag:--yolo",
    ]);
    expect(analysis.matches.every((entry) => entry.severity === "medium")).toBe(true);
  });

  it("ignores prose-only mentions outside code content", () => {
    const analysis = analyzeInstructionFlags(
      "CLAUDE.md",
      "Never run claude --dangerously-skip-permissions in this repository.\n",
    );
    expect(analysis.matches).toEqual([]);
  });

  it("recognizes documented instruction and prompt files", () => {
    expect(isInstructionFile("AGENTS.md")).toBe(true);
    expect(isInstructionFile("docs/CLAUDE.md")).toBe(true);
    expect(isInstructionFile(".github/copilot-instructions.md")).toBe(true);
    expect(isInstructionFile(".cursor/rules/style.mdc")).toBe(true);
    expect(isInstructionFile("prompts/review.md")).toBe(true);
    expect(isInstructionFile("fix.prompt")).toBe(true);
    expect(isInstructionFile("src/index.ts")).toBe(false);
  });
});

describe("skill tool grants", () => {
  it("flags unscoped execution and write tools", () => {
    const analysis = analyzeSkillFile("SKILL.md", [
      "---",
      "name: demo",
      "description: demo skill",
      "allowed-tools: Bash(git:*) Bash(*) Write",
      "---",
      "Body",
      "",
    ].join("\n"));
    expect(analysis.matches.map((entry) => entry.identity).sort()).toEqual([
      "skill-broad-tool:Bash(*)",
      "skill-broad-tool:Write",
    ]);
  });

  it("accepts scoped tool grants", () => {
    const analysis = analyzeSkillFile("SKILL.md", [
      "---",
      "name: demo",
      "description: demo skill",
      "allowed-tools:",
      "  - Read",
      "  - Bash(git status:*)",
      "---",
      "Body",
      "",
    ].join("\n"));
    expect(analysis.matches).toEqual([]);
  });
});

describe("Agent Surface Doctor permission coverage", () => {
  it("audits settings, instruction, and dotfile MCP surfaces", async () => {
    const files: Record<string, string> = {
      ".mcp.json": JSON.stringify({ mcpServers: { tools: { command: "npx", args: ["-y", "pkg"] } } }),
      ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
      "AGENTS.md": "```sh\nclaude --dangerously-skip-permissions\n```\n",
      ".agents/skills/demo/SKILL.md": [
        "---",
        "name: demo",
        "description: demo skill",
        "allowed-tools: Bash(*)",
        "---",
        "Body",
        "",
      ].join("\n"),
    };
    const doctor = createAgentSurfaceDoctor({
      readFile: async (absolutePath) => {
        const key = Object.keys(files).find((candidate) => absolutePath.endsWith(candidate));
        return Buffer.from(key === undefined ? "" : files[key]!);
      },
    });
    const result = await doctor.diagnose({
      snapshot: snapshotWith(Object.keys(files)),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual([
      "ai/agent-surface/instruction-permission-bypass",
      "ai/agent-surface/mcp-unpinned-package",
      "ai/agent-surface/permission-bypass",
      "ai/agent-surface/skill-broad-tool-grant",
    ]);
    const moduleCoverage = result.coverage?.find(
      (entry) => entry.moduleId === AGENT_SURFACE_DOCTOR_ID,
    );
    expect(moduleCoverage).toMatchObject({ status: "completed", filesExamined: 4 });
  });
});
