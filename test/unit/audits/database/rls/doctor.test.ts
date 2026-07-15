import { describe, expect, it, vi } from "vitest";
import { createRlsDoctor } from "../../../../../src/audits/database/rls/doctor.js";
import type { CatalogSnapshot } from "../../../../../src/audits/database/rls/types.js";
import { runDoctors } from "../../../../../src/core/registry.js";
import type { ProjectSnapshot } from "../../../../../src/workspace/types.js";

const snapshot: ProjectSnapshot = {
  root: "/repo",
  files: [],
  manifests: [],
  projects: [],
  workspaces: [],
};

function catalog(): CatalogSnapshot {
  return {
    tables: [{
      schema: "private",
      name: "documents",
      owner: "owner",
      rlsEnabled: false,
      forceRls: false,
      isPartitioned: false,
      estimatedRows: null,
    }],
    policies: [],
    relationPrivileges: [],
    defaultPrivileges: [],
    schemaPrivileges: [],
    roles: [],
    roleMemberships: [],
  };
}

describe("RLS doctor", () => {
  it("is skipped without database permission", async () => {
    const loader = vi.fn(async () => catalog());
    const doctor = createRlsDoctor({
      schemas: ["public"],
      statementTimeoutMs: 10_000,
      environment: { DATABASE_URL: "postgres://audit:secret@db.test/app" },
      loadCatalog: loader,
    });

    const [entry] = await runDoctors([doctor], snapshot, {
      runChecks: false,
      withDatabase: false,
    });

    expect(entry?.result).toMatchObject({
      status: "skipped",
      skipReason: expect.stringContaining("network:access"),
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it("loads configured schemas and returns normalized findings", async () => {
    const loader = vi.fn(async () => catalog());
    const doctor = createRlsDoctor({
      schemas: ["public", "private"],
      statementTimeoutMs: 4321,
      environment: { SUPABASE_DB_URL: "postgres://audit:secret@db.test/app" },
      loadCatalog: loader,
    });

    const [entry] = await runDoctors([doctor], snapshot, {
      runChecks: false,
      withDatabase: true,
    });

    expect(loader).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgres://audit:secret@db.test/app",
      schemas: ["public", "private"],
      statementTimeoutMs: 4321,
    }));
    expect(entry?.result).toMatchObject({
      status: "completed",
      findings: [expect.objectContaining({
        ruleId: "database/rls/rls-disabled",
        doctorId: "database/rls",
      })],
    });
  });

  it("reports missing credentials as an operational failure", async () => {
    const doctor = createRlsDoctor({
      schemas: ["public"],
      statementTimeoutMs: 10_000,
      environment: {},
      loadCatalog: vi.fn(async () => catalog()),
    });

    const [entry] = await runDoctors([doctor], snapshot, {
      runChecks: false,
      withDatabase: true,
    });

    expect(entry?.result).toMatchObject({
      status: "failed",
      error: {
        code: "doctor_execution_failed",
        message: expect.stringMatching(/missing.*DATABASE_URL/i),
      },
    });
  });

  it("sanitizes loader failures before registry reporting", async () => {
    const connectionString = "postgres://audit:very-secret@db.test/app";
    const doctor = createRlsDoctor({
      schemas: ["public"],
      statementTimeoutMs: 10_000,
      environment: { DATABASE_URL: connectionString },
      loadCatalog: async () => {
        throw new Error(`connection to ${connectionString} failed`);
      },
    });

    const [entry] = await runDoctors([doctor], snapshot, {
      runChecks: false,
      withDatabase: true,
    });
    const message = entry?.result.error?.message ?? "";

    expect(message).toContain("db.test/app");
    expect(message).not.toContain(connectionString);
    expect(message).not.toContain("very-secret");
  });
});
