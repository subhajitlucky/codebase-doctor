import { parse as parseJsonc } from "jsonc-parser";
import type { Confidence, Evidence, Severity } from "../../../core/findings.js";

export const AGENT_SURFACE_DOCTOR_ID = "ai/agent-surface";

export const MCP_CONFIG_BASENAMES = new Set([
  ".mcp.json",
  "mcp.json",
  "mcp_config.json",
  "mcp-config.json",
  "claude_desktop_config.json",
]);

const PACKAGE_RUNNERS = new Set(["npx", "bunx", "uvx", "pipx", "pnpm", "yarn", "npm"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const SECRET_KEY_PATTERN = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSWD)/iu;
const PLACEHOLDER_VALUE_PATTERN = /^(?:\$\{.*\}|\$[A-Z_]+|<.*>|your[-_ ].*|change[-_ ]?me|replace[-_ ].*|example.*|xxx+)$/iu;
const BROAD_ROOT_PATTERN = /^(?:\/|~|\$HOME|\/home(?:\/.*)?|\/Users(?:\/.*)?|[A-Za-z]:\\)$/u;

export interface AgentSurfaceMatch {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly path: string;
  readonly title: string;
  readonly message: string;
  readonly evidence: Evidence;
  readonly impact: string;
  readonly remediation: string;
  readonly identity: string;
}

export interface McpConfigAnalysis {
  readonly status: "supported" | "invalid";
  readonly servers: number;
  readonly matches: readonly AgentSurfaceMatch[];
  readonly limitations: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArgs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function basename(value: string): string {
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.at(-1) ?? value;
}

function match(
  path: string,
  ruleId: string,
  severity: Severity,
  confidence: Confidence,
  server: string,
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
    confidence,
    path,
    title,
    message,
    evidence: { type: "file", path, detail },
    impact,
    remediation,
    identity: `${server}:${identity}`,
  };
}

function isPinnedSpecifier(command: string, specifier: string): boolean {
  if (specifier.startsWith("-") || specifier.length === 0) return true;

  const runner = basename(command);
  if (runner === "uvx" || runner === "pipx") {
    const separator = specifier.indexOf("==");
    return separator > 0 && specifier.slice(separator + 2).length > 0;
  }

  const separator = specifier.startsWith("@") ? specifier.indexOf("@", 1) : specifier.indexOf("@");
  if (separator <= 0) return false;
  const version = specifier.slice(separator + 1);
  return /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/u.test(version);
}

function packageArgument(command: string, args: readonly string[]): string | undefined {
  const runner = basename(command);
  const positional = args.filter((argument) => !argument.startsWith("-"));
  if (runner === "pnpm" || runner === "yarn" || runner === "npm") {
    return positional[1];
  }
  return positional[0];
}

function analyzerMatches(path: string, server: string, command: string, args: readonly string[]): AgentSurfaceMatch[] {
  const matches: AgentSurfaceMatch[] = [];
  const runner = basename(command);

  if (SHELLS.has(runner.toLowerCase())) {
    matches.push(match(
      path,
      "mcp-shell-command",
      "medium",
      "high",
      server,
      `MCP server "${server}" runs through a shell`,
      `MCP server "${server}" uses ${runner} as its command, which can execute arbitrary shell input.`,
      `command ${runner}; a shell command in an agent config widens what a compromised or mistaken agent action can run.`,
      "shell-command",
      "A shell command in an agent config widens what a compromised or mistaken agent action can run.",
      "Replace the shell wrapper with a direct executable and pass separate, reviewable arguments.",
    ));
  }

  if (PACKAGE_RUNNERS.has(runner)) {
    const specifier = packageArgument(command, args);
    if (specifier !== undefined && !isPinnedSpecifier(command, specifier)) {
      matches.push(match(
        path,
        "mcp-unpinned-package",
        "medium",
        "high",
        server,
        `MCP server "${server}" runs an unpinned package`,
        `MCP server "${server}" invokes "${specifier}" without an exact version, so a later install can resolve different code.`,
        `package runner ${runner}; resolved package "${specifier}" is not pinned to an exact version.`,
        `unpinned:${specifier}`,
        "An unpinned agent tool can silently resolve to different code between runs.",
        "Pin the package to an exact version in the MCP configuration and review upgrades explicitly.",
      ));
    }
  }

  for (const argument of args) {
    if (BROAD_ROOT_PATTERN.test(argument) || argument === "--allow-write" || argument === "--read-write") {
      matches.push(match(
        path,
        "mcp-broad-filesystem",
        "medium",
        "high",
        server,
        `MCP server "${server}" is granted broad filesystem access`,
        `MCP server "${server}" receives "${argument}", which covers a root or home directory or enables writes.`,
        `argument "${argument}" grants broad filesystem scope to an agent tool.`,
        `broad-filesystem:${argument}`,
        "Broad filesystem scope lets an agent tool read or modify far more than the task requires.",
        "Scope the server to a specific subdirectory of the repository and drop write access unless it is required.",
      ));
    }
  }

  return matches;
}

function environmentMatches(
  path: string,
  server: string,
  environment: Record<string, unknown>,
): AgentSurfaceMatch[] {
  const matches: AgentSurfaceMatch[] = [];

  for (const [name, value] of Object.entries(environment)) {
    if (!SECRET_KEY_PATTERN.test(name)) continue;
    if (typeof value !== "string" || value.length < 20) continue;
    if (value.includes(" ") || /^https?:\/\//iu.test(value) || PLACEHOLDER_VALUE_PATTERN.test(value)) {
      continue;
    }
    matches.push(match(
      path,
      "mcp-secret-in-config",
      "high",
      "high",
      server,
      `MCP server "${server}" embeds a credential value`,
      `MCP server "${server}" sets ${name} inline in a repository config; the value is withheld from this report.`,
      `environment variable ${name} contains an inline value (value withheld).`,
      `secret:${name}`,
      "Inline credentials in agent configs are exposed to anyone with repository or workspace access.",
      "Move the value to an environment variable or secret store that the client resolves at runtime, and rotate the exposed value.",
    ));
  }

  return matches;
}

/**
 * Parses one MCP client configuration and returns precision-first findings.
 * Values of suspected credentials are never included in any match.
 */
export function analyzeMcpConfig(path: string, content: string): McpConfigAnalysis {
  let parsed: unknown;
  try {
    parsed = parseJsonc(content);
  } catch {
    return { status: "invalid", servers: 0, matches: [], limitations: [`${path}: MCP configuration is not valid JSON.`] };
  }
  if (!isObject(parsed)) {
    return { status: "invalid", servers: 0, matches: [], limitations: [`${path}: MCP configuration must contain a JSON object.`] };
  }

  const serverSection = isObject(parsed["mcpServers"])
    ? parsed["mcpServers"]
    : isObject(parsed["servers"])
      ? parsed["servers"]
      : undefined;
  if (serverSection === undefined) {
    return {
      status: "invalid",
      servers: 0,
      matches: [],
      limitations: [`${path}: MCP configuration has no mcpServers or servers mapping.`],
    };
  }

  const matches: AgentSurfaceMatch[] = [];
  const serverNames = Object.keys(serverSection).sort();

  for (const server of serverNames) {
    const definition = serverSection[server];
    if (!isObject(definition)) continue;
    const command = definition["command"];
    if (typeof command === "string" && command.length > 0) {
      matches.push(...analyzerMatches(path, server, command, stringArgs(definition["args"])));
    }
    if (isObject(definition["env"])) {
      matches.push(...environmentMatches(path, server, definition["env"]));
    }
  }

  return { status: "supported", servers: serverNames.length, matches, limitations: [] };
}
