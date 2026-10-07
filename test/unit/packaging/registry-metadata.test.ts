import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("agent distribution metadata", () => {
  it("keeps server.json consistent with the published npm package", async () => {
    const [server, manifest] = await Promise.all([
      json("server.json"),
      json("package.json"),
    ]);

    expect(server["$schema"]).toMatch(/modelcontextprotocol\.io\/schemas\/.*server\.schema\.json/);
    expect(typeof server["name"]).toBe("string");
    expect(server["name"]).toBe(manifest["mcpName"]);
    expect(server["version"]).toBe(manifest["version"]);

    const repository = server["repository"] as Record<string, string>;
    expect(repository["url"]).toBe("https://github.com/subhajitlucky/codebase-doctor");

    const packages = server["packages"] as Record<string, unknown>[];
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      registryType: "npm",
      identifier: manifest["name"],
      version: manifest["version"],
      transport: { type: "stdio" },
    });
    expect(packages[0]).not.toHaveProperty("environmentVariables");
  });

  it("ships a sandbox Dockerfile that serves the MCP server over stdio", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");

    expect(dockerfile).toMatch(/FROM node:22-slim/);
    expect(dockerfile).toMatch(/CMD \["node", "dist\/cli\.js", "mcp"\]/);
  });

  it("names a Glama maintainer for ownership claim", async () => {    const glama = await json("glama.json");

    expect(glama["$schema"]).toBe("https://glama.ai/mcp/schemas/server.json");
    const maintainers = glama["maintainers"] as unknown;
    expect(Array.isArray(maintainers)).toBe(true);
    expect((maintainers as string[]).length).toBeGreaterThan(0);
  });

  it("ships a versioned Claude Code plugin with a mirrored skill", async () => {
    const [plugin, manifest, skill, canonicalSkill, metadata, canonicalMetadata] =
      await Promise.all([
        json(".claude-plugin/plugin.json"),
        json("package.json"),
        readFile("skills/codebase-doctor/SKILL.md", "utf8"),
        readFile(".agents/skills/codebase-doctor/SKILL.md", "utf8"),
        readFile("skills/codebase-doctor/agents/openai.yaml", "utf8"),
        readFile(".agents/skills/codebase-doctor/agents/openai.yaml", "utf8"),
      ]);

    expect(plugin["name"]).toBe("codebase-doctor");
    expect(typeof plugin["description"]).toBe("string");
    expect(plugin["version"]).toBe(manifest["version"]);
    expect(skill).toBe(canonicalSkill);
    expect(metadata).toBe(canonicalMetadata);
  });
});
