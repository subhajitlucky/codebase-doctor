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

  it("places unified read-only auditing before explicitly permitted capabilities", async () => {
    const skill = await readFile(skillPath, "utf8");
    const readOnly = skill.indexOf("npx codebase-doctor audit . --json");
    const execution = skill.indexOf("--run-checks");
    const database = skill.indexOf("--with-database");

    expect(readOnly).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(readOnly);
    expect(database).toBeGreaterThan(readOnly);
    expect(skill).toMatch(/confirm|permission|approval/i);
  });

  it("references only implemented options and explains every exit code", async () => {
    const skill = await readFile(skillPath, "utf8");
    const options = [...new Set(skill.match(/--[a-z][a-z-]*/g) ?? [])].sort();

    expect(options).toEqual([
      "--baseline",
      "--database-schema",
      "--database-timeout",
      "--exclude",
      "--fail-on",
      "--format",
      "--json",
      "--run-checks",
      "--timeout",
      "--with-database",
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

  it("treats database coverage and credentials safely", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toMatch(/database.*skipped|skipped.*database/is);
    expect(skill).toMatch(/request|confirm|permission|approval/i);
    expect(skill).toMatch(/DATABASE_URL|SUPABASE_DB_URL/);
    expect(skill).toMatch(/never (?:print|echo|expose).*(?:credential|connection|string|secret)/is);
    expect(skill).toMatch(/failed.*not.*clean|never.*failed.*clean/is);
    expect(skill).toMatch(/scan.*backward-compatible|backward-compatible.*scan/is);
  });

  it("explains automatic static SQL coverage separately from live database state", async () => {
    const [skill, readme] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile("README.md", "utf8"),
    ]);

    for (const document of [skill, readme]) {
      expect(document).toMatch(/automatic(?:ally)?.*offline|offline.*automatic(?:ally)?/is);
      expect(document).toMatch(/partial coverage.*not.*clean|not.*clean.*partial coverage/is);
      expect(document).toMatch(/expected.*migration.*(?:observed|live)|(?:observed|live).*expected.*migration/is);
      expect(document).toMatch(/--with-database.*live|live.*--with-database/is);
    }
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
