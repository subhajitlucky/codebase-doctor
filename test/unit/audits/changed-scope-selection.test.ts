import { describe, expect, it } from "vitest";
import { createAgentSurfaceDoctor } from "../../../src/audits/ai/agent-surface/doctor.js";
import { createBackendApiDoctor } from "../../../src/audits/backend/api/doctor.js";
import { createBackendAuthDoctor } from "../../../src/audits/backend/auth/doctor.js";
import { createAccessibilityDoctor } from "../../../src/audits/frontend/accessibility/doctor.js";
import { createSeoDoctor } from "../../../src/audits/frontend/seo/doctor.js";
import { createFrontendSecurityDoctor } from "../../../src/audits/frontend/security/doctor.js";
import { createDockerDoctor } from "../../../src/audits/infrastructure/docker/doctor.js";
import { createGitHubActionsDoctor } from "../../../src/audits/infrastructure/github-actions/doctor.js";
import type { Doctor } from "../../../src/core/doctor.js";
import type { AuditScope, ChangedPath } from "../../../src/scope/types.js";
import type { FileRecord, ProjectSnapshot } from "../../../src/workspace/types.js";

function changedScope(changes: readonly ChangedPath[]): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes,
    affectedProjectIds: [],
    reasons: [],
    limitations: [],
  };
}

const CONTENTS: Record<string, string> = {
  "src/changed-auth.ts": [
    'import cors from "cors";',
    'import express from "express";',
    "const app = express();",
    'app.use(cors({ origin: "*", credentials: true }));',
    "",
  ].join("\n"),
  "src/unchanged-auth.ts": [
    'import cors from "cors";',
    'import express from "express";',
    "const app = express();",
    'app.use(cors({ origin: "*", credentials: true }));',
    "",
  ].join("\n"),
  "src/changed-api.js": [
    'import { Pool } from "pg";',
    "const pool = new Pool();",
    'export function byId(id) { return pool.query("SELECT * FROM u WHERE id = " + id); }',
    "",
  ].join("\n"),
  "src/unchanged-api.js": [
    'import { Pool } from "pg";',
    "const pool = new Pool();",
    'export function byId(id) { return pool.query("SELECT * FROM u WHERE id = " + id); }',
    "",
  ].join("\n"),
  "web/changed.tsx": [
    "export function Page({ html }: { html: string }) {",
    "  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
    "}",
    "",
  ].join("\n"),
  "web/unchanged.tsx": [
    "export function Bad({ html }: { html: string }) {",
    "  return <img src=\"x.png\" />;",
    "}",
    "",
  ].join("\n"),
  "web/changed.html": [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head><title>T</title></head>",
    "<body><img src=\"x.png\"></body></html>",
    "",
  ].join("\n"),
  Dockerfile: "FROM node\n",
  ".github/workflows/changed.yml": [
    "name: ci",
    "on: [push]",
    "jobs:",
    "  run:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo ${{ github.event.issue.title }}",
    "",
  ].join("\n"),
  "mcp.json": JSON.stringify({
    mcpServers: { tool: { command: "npx", args: ["pkg@1.0.0", "/"] } },
  }),
};

function snapshotWith(paths: readonly string[], changes: readonly ChangedPath[]): ProjectSnapshot {
  const files: FileRecord[] = paths.map((path) => ({
    path,
    kind: "file" as const,
    size: CONTENTS[path]?.length ?? 10,
  }));
  return {
    root: "/repo",
    files,
    manifests: [],
    projects: [],
    workspaces: [],
    auditScope: changedScope(changes),
  };
}

const ALL_PATHS = Object.keys(CONTENTS);
const CHANGES: ChangedPath[] = [
  { status: "modified", path: "src/changed-auth.ts" },
  { status: "modified", path: "src/changed-api.js" },
  { status: "modified", path: "web/changed.tsx" },
  { status: "modified", path: "web/changed.html" },
  { status: "added", path: "Dockerfile" },
  { status: "added", path: ".github/workflows/changed.yml" },
  { status: "added", path: "mcp.json" },
];

async function readFixtureFile(absolutePath: string): Promise<Uint8Array> {
  const relative = absolutePath.replace("/repo/", "");
  const content = CONTENTS[relative];
  if (content === undefined) throw new Error(`missing file ${relative}`);
  return Buffer.from(content, "utf8");
}

const DOCTORS: Record<string, () => Doctor> = {
  "backend/auth": () => createBackendAuthDoctor({ readFile: readFixtureFile }),
  "backend/api": () => createBackendApiDoctor({ readFile: readFixtureFile }),
  "frontend/accessibility": () => createAccessibilityDoctor({ readFile: readFixtureFile }),
  "frontend/seo": () => createSeoDoctor({ readFile: readFixtureFile }),
  "frontend/security": () => createFrontendSecurityDoctor({ readFile: readFixtureFile }),
  "infrastructure/docker": () => createDockerDoctor({ readFile: readFixtureFile }),
  "infrastructure/github-actions": () => createGitHubActionsDoctor({ readFile: readFixtureFile }),
  "ai/agent-surface": () => createAgentSurfaceDoctor({ readFile: readFixtureFile }),
};

describe("changed-scope file selection", () => {
  for (const [doctorId, create] of Object.entries(DOCTORS)) {
    it(`${doctorId} examines changed files without re-auditing the rest`, async () => {
      const doctor = create();
      const result = await doctor.diagnose({
        snapshot: snapshotWith(ALL_PATHS, CHANGES),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      expect(result.status).toBe("completed");
      const locations = result.findings
        .map((finding) => finding.location?.path)
        .filter((path): path is string => path !== undefined);
      expect(locations.length).toBeGreaterThan(0);
      for (const location of locations) {
        expect(
          CHANGES.map(({ path }) => path),
          `${doctorId} reported outside the changed scope: ${location}`,
        ).toContain(location);
      }
      expect(locations).not.toContain("src/unchanged-auth.ts");
      expect(locations).not.toContain("src/unchanged-api.js");
      expect(locations).not.toContain("web/unchanged.tsx");
      const coverage = result.coverage?.[0];
      expect(coverage?.scope).toBe("changed");
      expect(coverage?.limitations.join(" ")).toContain("unchanged files were not independently re-audited");
    });
  }

  it("reports not-selected when no candidate changed", async () => {
    const doctor = createBackendAuthDoctor();
    const result = await doctor.diagnose({
      snapshot: snapshotWith(["src/unchanged-auth.ts"], [
        { status: "modified", path: "README.md" },
      ]),
      allowedCapabilities: new Set(["filesystem:read"]),
    });

    expect(result.findings).toEqual([]);
    expect(result.coverage?.[0]).toMatchObject({ status: "not-selected", scope: "changed" });
  });
});
