import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const canonicalDocuments = [
  "README.md",
  "docs/architecture.md",
  ".agents/skills/codebase-doctor/SKILL.md",
] as const;

async function documents(paths: readonly string[]) {
  return Promise.all(paths.map(async (path) => ({
    path,
    text: await readFile(path, "utf8"),
  })));
}

describe("independent auditor product boundary", () => {
  it("states the permanent builder and verifier separation", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/Models build\. Codebase Doctor verifies\./i);
      expect(text, path).toMatch(/human|external coding agent|separately authorized.*agent/is);
      expect(text, path).toMatch(/Codebase Doctor (?:never|does not).*(?:edit|modify|apply|repair)/is);
      expect(text, path).toMatch(/remediation.*guidance|guidance.*remediation/is);
    }
  });

  it("does not reserve repair or write authority in canonical documents", async () => {
    const forbidden = [
      /safe repair/i,
      /controlled repair workflow/i,
      /repair-loop coordination/i,
      /AI explanations and repair/i,
      /filesystem:write/i,
    ];

    for (const { path, text } of await documents(canonicalDocuments)) {
      for (const pattern of forbidden) expect(text, `${path}: ${pattern}`).not.toMatch(pattern);
    }
  });
});
