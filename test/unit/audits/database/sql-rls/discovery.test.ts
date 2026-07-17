import { describe, expect, it } from "vitest";
import { discoverSqlStreams } from "../../../../../src/audits/database/sql-rls/discovery.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";

function snapshot(paths: readonly string[], projectRoots: readonly string[] = ["."]): ProjectSnapshot {
  return {
    root: "/repo",
    files: paths.map((path) => ({ path, kind: "file", size: 10 })),
    manifests: [],
    projects: projectRoots.map((root, index) => ({
      id: index === 0 ? "root" : `project-${index}`,
      root,
      ecosystems: ["node"],
      languages: ["typescript"],
      frameworks: [],
      manifestPaths: [],
      executionSupport: "supported",
    })),
    workspaces: [],
    auditScope: fullAuditScope(),
  };
}

describe("discoverSqlStreams", () => {
  it("discovers and orders a Supabase migration stream", () => {
    const streams = discoverSqlStreams(snapshot([
      "supabase/migrations/002_rls.sql",
      "supabase/config.toml",
      "supabase/migrations/001_init.sql",
    ]));

    expect(streams).toEqual([{
      id: "root:supabase/migrations",
      projectId: "root",
      root: "supabase/migrations",
      dialect: "postgresql",
      files: [
        "supabase/migrations/001_init.sql",
        "supabase/migrations/002_rls.sql",
      ],
    }]);
  });

  it("keeps Prisma, Drizzle, and generic roots independent", () => {
    const streams = discoverSqlStreams(snapshot([
      "prisma/migrations/001_init/migration.sql",
      "drizzle/0001_init.sql",
      "migrations/001_init.sql",
      "db/migrations/001_init.sql",
      "database/migrations/001_init.sql",
    ]));

    expect(streams.map(({ root }) => root)).toEqual([
      "database/migrations",
      "db/migrations",
      "drizzle",
      "migrations",
      "prisma/migrations",
    ]);
  });

  it("uses schema.sql only as a project fallback", () => {
    expect(discoverSqlStreams(snapshot(["schema.sql"]))).toEqual([
      expect.objectContaining({ id: "root:schema.sql", root: "schema.sql", files: ["schema.sql"] }),
    ]);
    expect(discoverSqlStreams(snapshot([
      "schema.sql",
      "migrations/001.sql",
    ])).map(({ root }) => root)).toEqual(["migrations"]);
  });

  it("associates streams with the deepest monorepo project", () => {
    const streams = discoverSqlStreams(snapshot([
      "migrations/001_root.sql",
      "packages/app/supabase/migrations/001_app.sql",
    ], [".", "packages/app"]));

    expect(streams).toEqual([
      expect.objectContaining({ projectId: "root", root: "migrations" }),
      expect.objectContaining({
        projectId: "project-1",
        root: "packages/app/supabase/migrations",
      }),
    ]);
  });
});
