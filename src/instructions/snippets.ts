export type InstructionTarget =
  | "agents"
  | "claude"
  | "cursor"
  | "windsurf"
  | "cline"
  | "copilot"
  | "mcp";

export const INSTRUCTION_TARGETS: readonly InstructionTarget[] = [
  "agents",
  "claude",
  "cursor",
  "windsurf",
  "cline",
  "copilot",
  "mcp"
];

export interface InstructionSnippet {
  target: InstructionTarget;
  file: string;
  description: string;
  content: string;
}

const CONTRACT = [
  "## Codebase Doctor verification",
  "",
  "After code edits, verify with the read-only auditor instead of assuming the change is complete:",
  "",
  "1. Run `codebase-doctor audit . --changed --format brief` after edits and fix findings that meet the failure threshold.",
  "2. Run a full `codebase-doctor audit . --format brief` at trust or release boundaries.",
  "3. Treat partial, skipped, unsupported, or failed coverage as unverified, never clean. Inspect `domainCoverage`, `doctorRuns`, and `coverage` in JSON reports.",
  "4. After repairing findings from a saved baseline, run `codebase-doctor verify . --baseline <report>.json --json` and only call a finding resolved when it reports `resolved`.",
  "5. Never enable `--run-checks` or `--with-database` without explicit user permission.",
  "",
  "Save a baseline when starting a repair loop:",
  "",
  "```bash",
  "codebase-doctor audit . --json > .codebase-doctor-baseline.json",
  "```",
  "",
  "Statement of scope: Codebase Doctor is read-only. It never edits files, executes repairs, or enables validation commands by default."
].join("\n");

const MCP_CONFIG = [
  "{",
  '  "mcpServers": {',
  '    "codebase-doctor": {',
  '      "command": "npx",',
  '      "args": ["-y", "codebase-doctor", "mcp"]',
  "    }",
  "  }",
  "}"
].join("\n");

const SNIPPETS: readonly InstructionSnippet[] = [
  {
    target: "agents",
    file: "AGENTS.md",
    description: "Repository agent instructions for any coding agent that reads AGENTS.md.",
    content: CONTRACT
  },
  {
    target: "claude",
    file: "CLAUDE.md",
    description: "Claude Code project instructions.",
    content: CONTRACT
  },
  {
    target: "cursor",
    file: ".cursor/rules/codebase-doctor.mdc",
    description: "Cursor project rule with frontmatter.",
    content: [
      "---",
      "description: Verify code changes with Codebase Doctor",
      "alwaysApply: true",
      "---",
      "",
      CONTRACT
    ].join("\n")
  },
  {
    target: "windsurf",
    file: ".windsurfrules",
    description: "Windsurf rules file.",
    content: CONTRACT
  },
  {
    target: "cline",
    file: ".clinerules/codebase-doctor.md",
    description: "Cline rules directory entry.",
    content: CONTRACT
  },
  {
    target: "copilot",
    file: ".github/copilot-instructions.md",
    description: "GitHub Copilot repository instructions.",
    content: CONTRACT
  },
  {
    target: "mcp",
    file: "MCP client configuration",
    description: "MCP server entry exposing audit_codebase, verify_changes, explain_finding, and describe_capabilities.",
    content: MCP_CONFIG
  }
];

export function instructionSnippets(
  targets: readonly InstructionTarget[] = INSTRUCTION_TARGETS
): InstructionSnippet[] {
  return SNIPPETS.filter((snippet) => targets.includes(snippet.target));
}

export function parseInstructionTargets(value: string | undefined): InstructionTarget[] {
  if (value === undefined || value === "all") {
    return [...INSTRUCTION_TARGETS];
  }

  const requested = value
    .split(",")
    .map((target) => target.trim().toLowerCase())
    .filter((target) => target.length > 0);

  if (requested.length === 0) {
    throw new Error("--target requires at least one target name.");
  }

  const invalid = requested.filter(
    (target) => !INSTRUCTION_TARGETS.includes(target as InstructionTarget)
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid instruction target "${invalid[0]}": expected ${INSTRUCTION_TARGETS.join(", ")}, or all.`
    );
  }

  return [...new Set(requested)] as InstructionTarget[];
}

export function renderInstructionText(snippets: readonly InstructionSnippet[]): string {
  const parts = snippets.map(
    (snippet) =>
      `# ${snippet.target} → ${snippet.file}\n\n${snippet.description}\n\n${snippet.content}`
  );

  return `${parts.join("\n\n---\n\n")}\n`;
}

export function renderInstructionJson(snippets: readonly InstructionSnippet[]): string {
  return `${JSON.stringify({ instructions: snippets }, null, 2)}\n`;
}
