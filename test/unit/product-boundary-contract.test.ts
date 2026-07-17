import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const canonicalDocuments = [
  "README.md",
  "docs/architecture.md",
  ".agents/skills/codebase-doctor/SKILL.md",
] as const;

const historicalPlans = [
  "docs/plans/2026-07-15-agent-verification-platform-design.md",
  "docs/plans/2026-07-15-codebase-doctor-design.md",
  "docs/plans/2026-07-15-codebase-doctor-v0.1-implementation.md",
  "docs/plans/2026-07-15-core-ci-foundation-design.md",
  "docs/plans/2026-07-15-core-ci-foundation.md",
  "docs/plans/2026-07-15-static-sql-rls-audit-design.md",
  "docs/plans/2026-07-15-static-sql-rls-audit.md",
  "docs/plans/2026-07-15-unified-rls-audit-design.md",
  "docs/plans/2026-07-15-unified-rls-audit.md",
] as const;

const supersededPlans = historicalPlans.slice(0, 2);
const targetWriteCapability = new RegExp(["filesystem", "write"].join(":"), "i");

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
      targetWriteCapability,
      /Codebase Doctor (?:fixes|applies|rewrites|mutates) (?:the )?target/i,
      /Codebase Doctor can (?:ever )?(?:receive|request|obtain|be granted).*(?:target[- ]write|write authority|repair permission)/i,
      /grant Codebase Doctor.*(?:target[- ]write|write authority|repair permission)/i,
    ];

    for (const { path, text } of await documents(canonicalDocuments)) {
      for (const pattern of forbidden) expect(text, `${path}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("documents changed audits as mixed-scope per doctor", async () => {
    for (const { path, text } of await documents(canonicalDocuments)) {
      expect(text, path).toMatch(/changed mode.*mixed[- ]scope|mixed[- ]scope.*changed mode/is);
      expect(text, path).toMatch(
        /Project Doctor.*full repository snapshot.*(?:manifests|lockfiles|workspaces|test visibility)/is,
      );
      expect(text, path).toMatch(
        /(?:configured validation|check).*plans?.*(?:filtered|restricted).*affectedProjectIds/is,
      );
      expect(text, path).toMatch(
        /static SQL.*affected migration streams?.*full current\s+history/is,
      );
      expect(text, path).toMatch(
        /live database.*full observed schema[- ]set\s+audit.*--with-database/is,
      );
      expect(text, path).not.toMatch(
        /does not audit unaffected repository areas|says nothing about unaffected repository areas/i,
      );
    }
  });

  it("keeps historical plans inside the same permanent boundary", async () => {
    const forbidden = [
      /repair-loop coordination/i,
      /verification-gated repair/i,
      /controlled (?:agent )?repair/i,
      /guide repair/i,
      /AI explanations and repair/i,
      targetWriteCapability,
    ];

    for (const { path, text } of await documents(historicalPlans)) {
      for (const pattern of forbidden) expect(text, `${path}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("does not label superseded product directions as approved", async () => {
    for (const { path, text } of await documents(supersededPlans)) {
      expect(text, path).toMatch(/^\*\*Status:\*\* Superseded[ \t]*$/m);
      expect(text, path).not.toMatch(/^\*\*Status:\*\* Approved/m);
    }
  });
});
