import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { AGENT_SURFACE_DOCTOR_ID, type AgentSurfaceMatch } from "./mcp-config.js";

export type PermissionConfigKind = "claude" | "vscode" | "aider";

const INSTRUCTION_BASENAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "copilot-instructions.md",
]);

const BYPASS_FLAGS = ["--dangerously-skip-permissions", "--yolo"] as const;

const BROAD_ALLOW_RULES = new Set([
  "*",
  "Bash",
  "Bash(*)",
  "Read(*)",
  "Read(//**)",
  "Write(*)",
  "Write(//**)",
  "Edit(*)",
  "Edit(//**)",
]);

export const BROAD_SKILL_TOOLS = new Set([
  "*",
  "Bash",
  "Bash(*)",
  "Write",
  "Write(*)",
  "Edit",
  "Edit(*)",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function permissionConfigKind(path: string): PermissionConfigKind | undefined {
  const segments = path.replaceAll("\\", "/").split("/");
  const basename = segments.at(-1) ?? path;
  const parent = segments.at(-2);
  if ((basename === "settings.json" || basename === "settings.local.json") && parent === ".claude") {
    return "claude";
  }
  if (basename === "settings.json" && parent === ".vscode") return "vscode";
  if (basename === ".aider.conf.yml" || basename === ".aider.conf.yaml") return "aider";
  return undefined;
}

export function isInstructionFile(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const basename = segments.at(-1) ?? path;
  if (INSTRUCTION_BASENAMES.has(basename)) return true;
  if (basename === "SKILL.md") return true;
  if (basename.endsWith(".mdc") && segments.includes(".cursor")) return true;
  if (/\.prompt(?:\.(?:md|txt))?$/iu.test(basename)) return true;
  if (segments.includes("prompts") && /\.(?:md|txt)$/iu.test(basename)) return true;
  return false;
}

function match(
  path: string,
  ruleId: string,
  severity: AgentSurfaceMatch["severity"],
  title: string,
  message: string,
  detail: string,
  identity: string,
  impact: string,
  remediation: string,
): AgentSurfaceMatch {
  return {
    ruleId: `${AGENT_SURFACE_DOCTOR_ID}/${ruleId}`,
    severity,
    confidence: "high",
    path,
    title,
    message,
    evidence: { type: "file", path, detail },
    impact,
    remediation,
    identity,
  };
}

export interface PermissionConfigAnalysis {
  readonly status: "supported" | "invalid";
  readonly entries: number;
  readonly matches: readonly AgentSurfaceMatch[];
  readonly limitations: readonly string[];
}

function analyzeClaudeSettings(path: string, data: Record<string, unknown>): PermissionConfigAnalysis {
  const matches: AgentSurfaceMatch[] = [];
  let entries = 0;
  const permissions = data["permissions"];
  if (isObject(permissions)) {
    if (permissions["defaultMode"] === "bypassPermissions") {
      matches.push(match(
        path,
        "permission-bypass",
        "high",
        "Agent permission prompts are configured to be bypassed",
        `${path} sets permissions.defaultMode to bypassPermissions, so the agent runs tool calls without interactive review.`,
        "permissions.defaultMode = bypassPermissions",
        "permission-bypass:defaultMode",
        "Every tool call in this workspace, including shell commands and file writes, executes without user confirmation.",
        "Use an explicit allowlist with defaultMode default or acceptEdits, and approve risky tool calls interactively.",
      ));
    }
    const allow = permissions["allow"];
    if (Array.isArray(allow)) {
      entries += allow.length;
      for (const rule of allow) {
        if (typeof rule !== "string" || !BROAD_ALLOW_RULES.has(rule.trim())) continue;
        matches.push(match(
          path,
          "broad-permission-allow",
          "medium",
          "Agent permission allowlist grants an unscoped tool",
          `${path} allows ${rule.trim()} without a scope, pre-approving every invocation of that tool.`,
          `permissions.allow entry ${rule.trim()}`,
          `broad-allow:${rule.trim()}`,
          "Unscoped allow rules remove the review step for destructive commands and arbitrary file writes.",
          "Replace the unscoped rule with the narrowest command or path patterns the workflow needs.",
        ));
      }
    }
  }

  const hooks = data["hooks"];
  if (isObject(hooks)) {
    for (const [event, definitions] of Object.entries(hooks)) {
      if (!Array.isArray(definitions)) continue;
      definitions.forEach((definition, index) => {
        if (!isObject(definition)) return;
        const commands = definition["hooks"];
        if (!Array.isArray(commands)) return;
        const hasCommand = commands.some((entry) => isObject(entry) && entry["type"] === "command");
        if (!hasCommand) return;
        entries += commands.length;
        matches.push(match(
          path,
          "hook-shell-command",
          "medium",
          "Agent hook executes a shell command on lifecycle events",
          `${path} configures a ${event} hook that runs a shell command when the agent session reaches that event.`,
          `hooks.${event}[${index}] runs a shell command. The command text is withheld.`,
          `hook-shell:${event}:${index}`,
          "Configured hook commands run outside the agent's permission review and can mutate the workspace.",
          "Review the hook command and keep only the hooks the workflow requires.",
        ));
      });
    }
  }

  return { status: "supported", entries, matches, limitations: [] };
}

function analyzeVscodeSettings(path: string, data: Record<string, unknown>): PermissionConfigAnalysis {
  const autoApprove = data["chat.tools.autoApprove"];
  if (autoApprove !== true) return { status: "supported", entries: 0, matches: [], limitations: [] };
  return {
    status: "supported",
    entries: 1,
    matches: [match(
      path,
      "permission-bypass",
      "high",
      "Agent tool calls are configured to auto-approve",
      `${path} sets chat.tools.autoApprove, so agent tool calls in this workspace run without confirmation.`,
      "chat.tools.autoApprove = true",
      "permission-bypass:chat.tools.autoApprove",
      "Auto-approved tool calls include edits and terminal commands, removing interactive review for everyone who opens this workspace.",
      "Remove the workspace auto-approve setting and approve tool calls per task, or scope it through explicit allow rules.",
    )],
    limitations: [],
  };
}

function analyzeAiderConfig(path: string, data: Record<string, unknown>): PermissionConfigAnalysis {
  const autoConfirm = data["yes-always"] === true || data["yes"] === true;
  if (!autoConfirm) return { status: "supported", entries: 0, matches: [], limitations: [] };
  const key = data["yes-always"] === true ? "yes-always" : "yes";
  return {
    status: "supported",
    entries: 1,
    matches: [match(
      path,
      "permission-bypass",
      "high",
      "Aider is configured to confirm every action automatically",
      `${path} sets ${key}, so Aider applies edits and runs commands without asking.`,
      `${key} = true`,
      `permission-bypass:${key}`,
      "Auto-confirmed edits and commands bypass the human review step for every change.",
      "Remove the auto-confirm setting and review changes interactively.",
    )],
    limitations: [],
  };
}

/**
 * Deterministic, offline analysis of documented agent permission settings.
 * Only known client configuration keys are interpreted; the configured
 * commands are never executed and hook command text is withheld.
 */
export function analyzePermissionConfig(
  path: string,
  kind: PermissionConfigKind,
  content: string,
): PermissionConfigAnalysis {
  if (kind === "aider") {
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      return { status: "invalid", entries: 0, matches: [], limitations: [`${path}: Aider config is not valid YAML.`] };
    }
    if (!isObject(parsed)) {
      return { status: "invalid", entries: 0, matches: [], limitations: [`${path}: Aider config must be a YAML mapping.`] };
    }
    return analyzeAiderConfig(path, parsed);
  }

  let parsed: unknown;
  const errors: { error: number; offset: number; length: number }[] = [];
  try {
    parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  } catch {
    return { status: "invalid", entries: 0, matches: [], limitations: [`${path}: agent settings are not valid JSON.`] };
  }
  if (errors.length > 0 || !isObject(parsed)) {
    return { status: "invalid", entries: 0, matches: [], limitations: [`${path}: agent settings are not valid JSON.`] };
  }
  return kind === "claude"
    ? analyzeClaudeSettings(path, parsed)
    : analyzeVscodeSettings(path, parsed);
}

export interface InstructionFlagAnalysis {
  readonly matches: readonly AgentSurfaceMatch[];
}

/**
 * Reports permission-bypass flags that instruction or prompt files present as
 * commands: the flag must appear inside a fenced code block or inline code
 * span. A prose mention or warning is not a finding.
 */
export function analyzeInstructionFlags(path: string, content: string): InstructionFlagAnalysis {
  const matches: AgentSurfaceMatch[] = [];
  const hits = new Set<string>();
  let fence: string | undefined;

  for (const line of content.split(/\r?\n/u)) {
    const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMarker !== undefined) {
      fence = fence === undefined ? fenceMarker : undefined;
      continue;
    }
    const inCode = fence !== undefined || /`[^`\n]+`/u.test(line);
    if (!inCode) continue;
    for (const flag of BYPASS_FLAGS) {
      if (line.includes(flag)) hits.add(flag);
    }
  }

  for (const flag of hits) {
    matches.push(match(
      path,
      "instruction-permission-bypass",
      "medium",
      "Agent instructions present a permission-bypass command",
      `${path} shows ${flag} inside code content, directing readers or agents to run with permission prompts disabled.`,
      `code content references ${flag}`,
      `instruction-flag:${flag}`,
      "Following the instruction runs the agent without interactive approval for tool calls.",
      "Remove the bypass instruction or replace it with the ordinary command and an explicit approval workflow.",
    ));
  }

  return { matches };
}
