import { describe, expect, it } from "vitest";
import {
  discoverSqlStreams,
  identifySqlStream,
  selectSqlStreams,
} from "../../../../../src/audits/database/sql-rls/discovery.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope, ChangedPath } from "../../../../../src/scope/types.js";
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

function changedAuditScope(changes: readonly ChangedPath[]): AuditScope {
  return {
    mode: "changed",
    base: {
      kind: "head",
      requestedRef: null,
      resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    },
    changes,
    affectedProjectIds: [],
    reasons: [],
    limitations: [],
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

  it("selects every stream in full mode without changing discovery order", () => {
    const streams = discoverSqlStreams(snapshot([
      "supabase/migrations/001.sql",
      "migrations/001.sql",
    ]));

    expect(selectSqlStreams(streams, fullAuditScope())).toEqual(streams);
  });

  it("selects only the stream containing a changed SQL migration", () => {
    const streams = discoverSqlStreams(snapshot([
      "supabase/migrations/001.sql",
      "supabase/migrations/002.sql",
      "migrations/001.sql",
    ]));

    expect(selectSqlStreams(streams, changedAuditScope([
      { status: "modified", path: "supabase/migrations/002.sql" },
    ])).map(({ root }) => root)).toEqual(["supabase/migrations"]);
  });

  it("uses both rename paths but only the destination of a copy", () => {
    const streams = discoverSqlStreams(snapshot([
      "db/migrations/001.sql",
      "prisma/migrations/001/migration.sql",
      "supabase/migrations/002.sql",
    ]));

    expect(selectSqlStreams(streams, changedAuditScope([{
      status: "renamed",
      previousPath: "db/migrations/001.sql",
      path: "supabase/migrations/002.sql",
    }])).map(({ root }) => root)).toEqual(["db/migrations", "supabase/migrations"]);
    expect(selectSqlStreams(streams, changedAuditScope([{
      status: "copied",
      previousPath: "prisma/migrations/001/migration.sql",
      path: "supabase/migrations/002.sql",
    }])).map(({ root }) => root)).toEqual(["supabase/migrations"]);
  });

  it("requires SQL suffixes for current, rename-old, and copy-destination paths", () => {
    const streams = discoverSqlStreams(snapshot([
      "db/migrations/001.sql",
      "supabase/migrations/001.sql",
    ]));

    expect(selectSqlStreams(streams, changedAuditScope([
      { status: "modified", path: "supabase/migrations/README.md" },
      {
        status: "renamed",
        previousPath: "db/migrations/README.md",
        path: "docs/migrations.md",
      },
      {
        status: "copied",
        previousPath: "db/migrations/001.sql",
        path: "supabase/migrations/README.md",
      },
    ]))).toEqual([]);
    expect(selectSqlStreams(streams, changedAuditScope([{
      status: "renamed",
      previousPath: "db/migrations/001.SQL",
      path: "docs/001.txt",
    }])).map(({ root }) => root)).toEqual(["db/migrations"]);
    expect(selectSqlStreams(streams, changedAuditScope([{
      status: "copied",
      previousPath: "db/migrations/README.md",
      path: "supabase/migrations/002.SQL",
    }])).map(({ root }) => root)).toEqual(["supabase/migrations"]);
  });

  it("matches stream roots on slash segment boundaries and preserves literal backslashes", () => {
    const streams = discoverSqlStreams(snapshot([
      "migrations/001.sql",
      "migrations-old/001.sql",
    ]));

    expect(selectSqlStreams(streams, changedAuditScope([
      { status: "modified", path: "migrations-old/001.sql" },
      { status: "modified", path: "migrations\\002.sql" },
    ]))).toEqual([]);
  });

  it("maps known roots and schema fallback using deepest project ownership", () => {
    const value = snapshot([], [".", "packages/app"]);

    expect(identifySqlStream(value, "packages/app/database/migrations/001.sql")).toEqual({
      id: "project-1:database/migrations",
      projectId: "project-1",
      root: "packages/app/database/migrations",
    });
    expect(identifySqlStream(value, "packages/app/schema.sql")).toEqual({
      id: "project-1:schema.sql",
      projectId: "project-1",
      root: "packages/app/schema.sql",
    });
    expect(identifySqlStream(value, "packages/app/database/migrations/001.SQL")).toEqual({
      id: "project-1:database/migrations",
      projectId: "project-1",
      root: "packages/app/database/migrations",
    });
    expect(identifySqlStream(value, "packages/app/database/migrations/README.md"))
      .toBeUndefined();
    expect(identifySqlStream(value, "packages/app/sql/one.sql")).toBeUndefined();
    expect(identifySqlStream(value, "packages/app\\migrations/one.sql")).toBeUndefined();
  });
});
