import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeDatabaseSchemas,
  parseDatabaseTimeout,
} from "../../src/commands/audit.js";

const repositoryRoot = process.cwd();
const fixture = (name: string) => resolve(repositoryRoot, "test", "fixtures", name);

function cli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(repositoryRoot, "src", "cli.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, DATABASE_URL: "", SUPABASE_DB_URL: "" },
    },
  );
}

describe("audit CLI", () => {
  it("combines repository auditing with visible skipped database coverage", () => {
    const result = cli(["audit", fixture("node-pass"), "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/rls",
      status: "skipped",
      skipReason: expect.stringContaining("network:access"),
    }));
  });

  it("fails requested database coverage when credentials are missing", () => {
    const result = cli(["audit", fixture("node-pass"), "--with-database", "--json"]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(2);
    expect(report.doctorRuns).toContainEqual(expect.objectContaining({
      doctorId: "database/rls",
      status: "failed",
      error: expect.objectContaining({ message: expect.stringMatching(/DATABASE_URL/) }),
    }));
  });

  it("accepts repeatable database schemas without enabling a connection", () => {
    const result = cli([
      "audit",
      fixture("node-pass"),
      "--database-schema",
      "public",
      "--database-schema",
      "private",
      "--json",
    ]);

    expect(result.status).toBe(0);
  });

  it.each([
    ["--database-timeout", "zero"],
    ["--database-timeout", "0"],
    ["--database-schema", ""],
  ])("rejects invalid database option %s %s", (option, value) => {
    const result = cli(["audit", fixture("node-pass"), option, value]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/database|schema|timeout|invalid/i);
  });

  it("does not expose a connection-string CLI option", () => {
    const result = cli([
      "audit",
      fixture("node-pass"),
      "--connection",
      "postgres://audit:secret@db.test/app",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option.*--connection/i);
  });
});

describe("database option normalization", () => {
  it("defaults, trims, and deduplicates schemas", () => {
    expect(normalizeDatabaseSchemas([])).toEqual(["public"]);
    expect(normalizeDatabaseSchemas([" public ", "private", "public"])).toEqual([
      "public",
      "private",
    ]);
  });

  it("parses a bounded positive timeout", () => {
    expect(parseDatabaseTimeout("10000")).toBe(10_000);
    expect(() => parseDatabaseTimeout("0")).toThrow(/timeout/i);
  });
});
