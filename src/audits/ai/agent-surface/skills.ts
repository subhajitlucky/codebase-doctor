import { parse as parseYaml } from "yaml";
import { AGENT_SURFACE_DOCTOR_ID, type AgentSurfaceMatch } from "./mcp-config.js";
import { BROAD_SKILL_TOOLS } from "./permissions.js";

export interface SkillFileAnalysis {
  readonly status: "supported" | "invalid";
  readonly matches: readonly AgentSurfaceMatch[];
  readonly limitations: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingFrontmatterMatch(path: string, missing: readonly string[]): AgentSurfaceMatch {
  const fields = missing.join(", ");
  return {
    ruleId: `${AGENT_SURFACE_DOCTOR_ID}/skill-frontmatter-missing`,
    severity: "low",
    confidence: "high",
    path,
    title: `Agent skill is missing required frontmatter: ${fields}`,
    message: `Skill file ${path} does not declare ${fields} in its frontmatter, so clients cannot reliably list or describe it.`,
    evidence: {
      type: "file",
      path,
      detail: `missing frontmatter field(s): ${fields}.`,
    },
    impact: "Agent clients rely on skill frontmatter to decide when to load a skill.",
    remediation: `Add a YAML frontmatter block with non-empty ${fields} fields.`,
    identity: `skill-frontmatter:${fields}`,
  };
}

function broadToolMatches(path: string, value: unknown): AgentSurfaceMatch[] {
  const tokens = typeof value === "string"
    ? value.split(/[,\s]+/u)
    : Array.isArray(value)
      ? value.flatMap((entry) => typeof entry === "string" ? entry.split(/[,\s]+/u) : [])
      : [];
  const matches: AgentSurfaceMatch[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length === 0 || !BROAD_SKILL_TOOLS.has(token) || seen.has(token)) continue;
    seen.add(token);
    matches.push({
      ruleId: `${AGENT_SURFACE_DOCTOR_ID}/skill-broad-tool-grant`,
      severity: "medium",
      confidence: "high",
      path,
      title: `Agent skill pre-approves an unscoped tool: ${token}`,
      message: `Skill file ${path} lists ${token} in allowed-tools without a scope, pre-approving every invocation of that tool.`,
      evidence: {
        type: "file",
        path,
        detail: `allowed-tools entry ${token}`,
      },
      impact: "A skill that pre-approves unscoped execution or write tools removes the review step for those actions.",
      remediation: "Narrow the allowed-tools entry to the smallest command or path pattern the skill needs.",
      identity: `skill-broad-tool:${token}`,
    });
  }
  return matches;
}

/**
 * Validates one SKILL.md file: it must start with YAML frontmatter that
 * declares non-empty name and description fields. This is a deterministic,
 * offline check; the skill is never executed.
 */
export function analyzeSkillFile(path: string, content: string): SkillFileAnalysis {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (!normalized.startsWith("---")) {
    return {
      status: "supported",
      matches: [missingFrontmatterMatch(path, ["name", "description"])],
      limitations: [],
    };
  }

  const closed = /\r?\n---\r?\n/u.exec(normalized.slice(3));
  const yamlText = closed === null ? normalized.slice(3) : normalized.slice(3, closed.index + 3);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return {
      status: "invalid",
      matches: [],
      limitations: [`${path}: skill frontmatter is not valid YAML.`],
    };
  }

  if (!isObject(parsed)) {
    return {
      status: "invalid",
      matches: [],
      limitations: [`${path}: skill frontmatter must be a YAML mapping.`],
    };
  }

  const missing: string[] = [];
  const name = parsed["name"];
  const description = parsed["description"];
  if (typeof name !== "string" || name.trim().length === 0) missing.push("name");
  if (typeof description !== "string" || description.trim().length === 0) missing.push("description");
  const toolMatches = broadToolMatches(path, parsed["allowed-tools"]);
  const matches = missing.length === 0 ? toolMatches : [missingFrontmatterMatch(path, missing)];
  if (missing.length > 0) matches.push(...toolMatches);

  return {
    status: "supported",
    matches,
    limitations: [],
  };
}
