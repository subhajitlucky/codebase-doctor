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

  it("uses an already-installed binary before explicitly permitted capabilities", async () => {
    const skill = await readFile(skillPath, "utf8");
    const readOnly = skill.indexOf("codebase-doctor audit . --json");
    const execution = skill.indexOf("--run-checks");
    const database = skill.indexOf("--with-database");

    expect(readOnly).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(readOnly);
    expect(database).toBeGreaterThan(readOnly);
    expect(skill).toMatch(/confirm|permission|approval/i);
    expect(skill).not.toMatch(/\bnpx\s+codebase-doctor\b/i);
    expect(skill).toMatch(/trusted.*already-installed|already-installed.*trusted/is);
    expect(skill).toMatch(/package acquisition|package update/is);
    expect(skill).toMatch(/pinned.*user-authorized|user-authorized.*pinned/is);
    expect(skill).toMatch(/network.*cache writes|cache writes.*network/is);
  });

  it("references only implemented options and explains every exit code", async () => {
    const skill = await readFile(skillPath, "utf8");
    const options = [...new Set(skill.match(/--[a-z][a-z-]*/g) ?? [])].sort();

    expect(options).toEqual([
      "--base",
      "--baseline",
      "--changed",
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

  it("assigns repairs to an external actor and verification to Codebase Doctor", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toMatch(/human|external coding agent|separately authorized.*agent/is);
    expect(skill).toMatch(/Codebase Doctor (?:never|does not).*(?:edit|modify|apply|repair)/is);
    expect(skill).toMatch(/after.*(?:human|agent).*(?:change|fix).*rerun|rerun.*after.*(?:change|fix)/is);
  });

  it("teaches honest changed-audit verification", async () => {
    const skill = await readFile(skillPath, "utf8");
    const changedAudit = skill.indexOf("codebase-doctor audit . --changed --json");
    const fullAudit = skill.indexOf("codebase-doctor audit . --json");

    expect(skill).toMatch(/prefer.*changed.*after.*edit/is);
    expect(skill).toMatch(/full audit.*(?:trust|release) boundar/is);
    expect(changedAudit).toBeGreaterThan(-1);
    expect(fullAudit).toBeGreaterThan(changedAudit);
    expect(skill).toMatch(/auditScope.*doctorRuns.*coverage.*findings/is);
    expect(skill).toMatch(/changed mode.*mixed[- ]scope|mixed[- ]scope.*changed mode/is);
    expect(skill).toMatch(/Project Doctor.*full repository snapshot/is);
    expect(skill).toMatch(/plans?.*filtered.*affectedProjectIds/is);
    expect(skill).toMatch(/SQL.*affected migration streams?.*full current\s+history/is);
    expect(skill).toMatch(/never treat.*zero.*changed.*findings.*(?:full|repository).*clean/is);
    expect(skill).toMatch(/rerun.*same scope/is);
    expect(skill).toMatch(/do not claim.*resolved.*outside.*coverage/is);
    expect(skill).toMatch(/fingerprint.*absent.*coverage.*completed/is);
    expect(skill).toMatch(/--base.*optional.*mode|optional.*--base.*mode/is);
    expect(skill).toMatch(/--base.*present.*missing operand.*invalid ref.*exit `?2`?/is);
  });

  it("teaches agents to interpret the complete domain coverage checklist", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toMatch(/domainCoverage/);
    expect(skill).toMatch(/nine|9.*domains|domains.*nine|domains.*9/is);
    expect(skill).toMatch(/applicability.*status|status.*applicability/is);
    expect(skill).toMatch(/coverageComplete/);
    expect(skill).toMatch(/coverageComplete.*does not mean.*(?:bug[- ]free|no bugs|correct)/is);
    expect(skill).toMatch(/unsupported|unknown|not-selected/is);
  });

  it("teaches agents to handle secret findings without exposing or fixing values", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toMatch(/security\/secrets/);
    expect(skill).toMatch(/ignored.*\.env.*(?:normal|not.*finding|not.*scan)/is);
    expect(skill).toMatch(/tracked|repository-shareable/is);
    expect(skill).toMatch(/value.*withheld|withhold.*value/is);
    expect(skill).toMatch(/never.*fingerprint|fingerprint.*never/is);
    expect(skill).toMatch(/precision-first.*not exhaustive|not exhaustive.*precision-first/is);
    expect(skill).toMatch(/external.*(?:rotate|revoke|remediat).*rerun|(?:rotate|revoke|remediat).*external.*rerun/is);
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
