import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_TARGETS,
  instructionSnippets,
  parseInstructionTargets,
  renderInstructionJson,
  renderInstructionText
} from "../../../src/instructions/snippets.js";

describe("instruction snippets", () => {
  it("covers every supported target with file, description, and content", () => {
    const snippets = instructionSnippets();

    expect(snippets.map((snippet) => snippet.target)).toEqual([...INSTRUCTION_TARGETS]);
    for (const snippet of snippets) {
      expect(snippet.file.length).toBeGreaterThan(0);
      expect(snippet.description.length).toBeGreaterThan(0);
      expect(snippet.content.length).toBeGreaterThan(0);
    }
  });

  it("states the verification contract and honest coverage semantics", () => {
    const agents = instructionSnippets(["agents"])[0]!;

    expect(agents.file).toBe("AGENTS.md");
    expect(agents.content).toContain("--changed --format brief");
    expect(agents.content).toContain("verify . --baseline");
    expect(agents.content).toContain("partial, skipped, unsupported, or failed coverage as unverified");
    expect(agents.content).toContain("read-only");
    expect(agents.content).toContain("--run-checks");
  });

  it("emits Cursor frontmatter and a valid MCP configuration", () => {
    const cursor = instructionSnippets(["cursor"])[0]!;
    expect(cursor.file).toBe(".cursor/rules/codebase-doctor.mdc");
    expect(cursor.content.startsWith("---\n")).toBe(true);
    expect(cursor.content).toContain("alwaysApply: true");

    const mcp = instructionSnippets(["mcp"])[0]!;
    const parsed = JSON.parse(mcp.content) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers["codebase-doctor"]).toMatchObject({
      command: "npx",
      args: ["-y", "codebase-doctor", "mcp"]
    });
  });

  it("renders text and JSON deterministically", () => {
    const snippets = instructionSnippets(["agents"]);
    expect(renderInstructionText(snippets)).toContain("# agents → AGENTS.md");

    const parsed = JSON.parse(renderInstructionJson(snippets)) as {
      instructions: { target: string }[];
    };
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0]?.target).toBe("agents");
  });
});

describe("parseInstructionTargets", () => {
  it("defaults to all targets", () => {
    expect(parseInstructionTargets(undefined)).toEqual([...INSTRUCTION_TARGETS]);
    expect(parseInstructionTargets("all")).toEqual([...INSTRUCTION_TARGETS]);
  });

  it("accepts comma-separated targets with case and whitespace tolerance", () => {
    expect(parseInstructionTargets(" Cursor, claude ,cursor")).toEqual(["cursor", "claude"]);
  });

  it("rejects unknown or empty target lists", () => {
    expect(() => parseInstructionTargets("vscode")).toThrow(/Invalid instruction target/u);
    expect(() => parseInstructionTargets(" , ")).toThrow(/at least one target/u);
  });
});
