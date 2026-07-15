import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const skillPath = ".agents/skills/codebase-doctor/SKILL.md";

describe("Codebase Doctor agent skill contract", () => {
  it("has minimal trigger-focused frontmatter", async () => {
    const skill = await readFile(skillPath, "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1];

    expect(frontmatter).toMatch(/^name: codebase-doctor$/m);
    expect(frontmatter).toMatch(/^description: .*(scan|diagnos|validat).*(repository|codebase)/im);
    expect(frontmatter?.split("\n").map((line) => line.split(":", 1)[0])).toEqual([
      "name",
      "description",
    ]);
  });

  it("places read-only discovery before explicitly permitted execution", async () => {
    const skill = await readFile(skillPath, "utf8");
    const readOnly = skill.indexOf("npx codebase-doctor scan . --json");
    const execution = skill.indexOf("--run-checks");

    expect(readOnly).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(readOnly);
    expect(skill).toMatch(/confirm|permission|approval/i);
  });

  it("references only implemented options and explains every exit code", async () => {
    const skill = await readFile(skillPath, "utf8");
    const options = [...new Set(skill.match(/--[a-z][a-z-]*/g) ?? [])].sort();

    expect(options).toEqual([
      "--baseline",
      "--exclude",
      "--fail-on",
      "--format",
      "--json",
      "--run-checks",
      "--timeout",
    ]);
    expect(skill).toMatch(/exit (?:code )?`?0`?.*(completed|threshold)/i);
    expect(skill).toMatch(/exit (?:code )?`?1`?.*finding/i);
    expect(skill).toMatch(/exit (?:code )?`?2`?.*(could not|operational|invalid)/i);
    expect(skill).toMatch(/never treat exit `?2`? as (?:a )?clean/i);
  });

  it("warns about untrusted execution without claiming universal bug detection", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toMatch(/do not.*--run-checks.*untrusted repository/is);
    expect(skill).not.toMatch(/finds? every bug|finds? all bugs|detects? every bug/i);
  });

  it("ships OpenAI display metadata without provider-specific workflow logic", async () => {
    const metadata = await readFile(
      ".agents/skills/codebase-doctor/agents/openai.yaml",
      "utf8",
    );

    expect(metadata).toMatch(/display_name: "Codebase Doctor"/);
    expect(metadata).toMatch(/short_description:/);
  });
});
