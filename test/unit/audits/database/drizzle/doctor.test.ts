import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDrizzleDoctor } from "../../../../../src/audits/database/drizzle/doctor.js";
import { fullAuditScope } from "../../../../../src/scope/planner.js";
import type { AuditScope } from "../../../../../src/scope/types.js";
import type { DetectedProject, ProjectSnapshot } from "../../../../../src/workspace/types.js";

function file(path: string, content: string) {
  return { path, kind: "file" as const, size: Buffer.byteLength(content) };
}

function project(dependencies: readonly string[] = ["drizzle-orm", "postgres"]): DetectedProject {
  return {
    id: "root",
    root: ".",
    ecosystems: ["node"],
    languages: ["typescript"],
    frameworks: [],
    dependencyNames: dependencies,
    manifestPaths: ["package.json"],
    executionSupport: "supported",
  };
}

function changedScope(changes: AuditScope["changes"]): AuditScope {
  return {
    mode: "changed",
    base: { kind: "head", requestedRef: null, resolvedCommit: "a".repeat(40) },
    changes,
    affectedProjectIds: ["root"],
    reasons: [],
    limitations: [],
  };
}

function snapshot(
  contents: ReadonlyMap<string, string>,
  overrides: Partial<ProjectSnapshot> = {},
): ProjectSnapshot {
  return {
    root: "/repo",
    files: [...contents].map(([path, content]) => file(path, content)),
    manifests: [],
    projects: [project()],
    workspaces: [],
    auditScope: fullAuditScope(),
    ...overrides,
  };
}

function reader(contents: ReadonlyMap<string, string>) {
  return vi.fn(async (absolutePath: string, allowance: number) => {
    const path = absolutePath.replace(/^\/repo\//u, "");
    const content = contents.get(path);
    if (content === undefined) throw new Error("sensitive host error");
    return Buffer.from(content).subarray(0, allowance + 1);
  });
}

async function diagnose(
  contents: ReadonlyMap<string, string>,
  options: Parameters<typeof createDrizzleDoctor>[0] = {},
  overrides: Partial<ProjectSnapshot> = {},
) {
  const readFile = options.readFile ?? reader(contents);
  const doctor = createDrizzleDoctor({ ...options, readFile });
  const result = await doctor.diagnose({
    snapshot: snapshot(contents, overrides),
    allowedCapabilities: new Set(["filesystem:read"]),
  });
  return { doctor, readFile, result };
}

describe("Drizzle Doctor", () => {
  it("has exactly the read-only capability and never exposes target-write authority", async () => {
    const doctor = createDrizzleDoctor({ readFile: async () => Buffer.from("") });
    expect(doctor).toMatchObject({
      id: "database/drizzle",
      version: "0.1.0",
      capabilities: ["filesystem:read"],
    });
    expect(await doctor.supports(snapshot(new Map()))).toBe(true);
    expect(JSON.stringify(doctor)).not.toMatch(/write|execute|network/iu);
  });

  it("emits a redacted deterministic medium/high finding with external-only guidance", async () => {
    const raw = [
      'import { sql } from "drizzle-orm";',
      'sql`private recovery token ${new Date("2042-09-13")}`;',
    ].join("\n");
    const contents = new Map([["src/query.ts", raw]]);
    const first = await diagnose(contents);
    const second = await diagnose(contents);

    expect(first.result.findings).toEqual([expect.objectContaining({
      doctorId: "database/drizzle",
      ruleId: "database/drizzle/raw-sql-date-parameter",
      severity: "medium",
      confidence: "high",
      category: "database",
      location: { path: "src/query.ts", line: 2, column: 30 },
      evidence: [{
        type: "file",
        path: "src/query.ts",
        detail: "A direct-date-construction value is interpolated through the imported Drizzle sql binding 'sql'; source and parameter content were withheld.",
      }],
      remediationConstraints: expect.arrayContaining([
        expect.stringMatching(/authorized human or external coding agent/iu),
      ]),
      remediation: expect.stringMatching(/lte\(column, date\).*explicit encoder/iu),
      verification: {
        command: "codebase-doctor audit . --json",
        expected: expect.stringMatching(/fingerprint is absent.*coverage completed/iu),
      },
    })]);
    expect(first.result.findings[0]?.fingerprint).toBe(second.result.findings[0]?.fingerprint);
    expect(first.result.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(first.result);
    expect(serialized).not.toContain("private recovery token");
    expect(serialized).not.toContain("2042-09-13");
    expect(serialized).not.toContain("new Date");
  });

  it("keeps the fingerprint stable when only the local sql alias changes", async () => {
    const first = new Map([["src/query.ts", [
      'import { sql as raw } from "drizzle-orm";',
      'raw`${new Date()}`;',
    ].join("\n")]]);
    const second = new Map([["src/query.ts", [
      'import { sql as tag } from "drizzle-orm";',
      'tag`${new Date()}`;',
    ].join("\n")]]);

    const firstResult = await diagnose(first);
    const secondResult = await diagnose(second);
    expect(firstResult.result.findings[0]?.location).toEqual(
      secondResult.result.findings[0]?.location,
    );
    expect(firstResult.result.findings[0]?.fingerprint).toBe(
      secondResult.result.findings[0]?.fingerprint,
    );
    expect(firstResult.result.findings[0]?.evidence).not.toEqual(
      secondResult.result.findings[0]?.evidence,
    );
  });

  it("does not flag typed comparisons or fresh inline explicit encoders", async () => {
    const contents = new Map([["src/query.ts", [
      'import { sql, lte } from "drizzle-orm";',
      "const cutoff = new Date();",
      "db.select().where(lte(table.availableAt, cutoff));",
      "sql`available_at <= ${sql.param(cutoff, { mapToDriverValue: (value: Date) => value.toISOString() })}`;",
    ].join("\n")]]);
    const { result } = await diagnose(contents);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "completed",
      statementsRecognized: 0,
    })]);
  });

  it("reports partial coverage for a const explicit encoder", async () => {
    const contents = new Map([["src/query.ts", [
      'import { sql } from "drizzle-orm";',
      "const cutoff = new Date();",
      "const encoder = { mapToDriverValue: (value: Date) => value.toISOString() };",
      "sql`available_at <= ${sql.param(cutoff, encoder)}`;",
    ].join("\n")]]);
    const { result } = await diagnose(contents);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      limitations: [expect.stringMatching(/raw Drizzle value interpolation could not be classified/iu)],
    })]);
  });

  it("reports partial coverage when an explicit encoder argument cannot be proven", async () => {
    const contents = new Map([["src/query.ts", [
      'import { sql } from "drizzle-orm";',
      "const cutoff = new Date();",
      "sql`available_at <= ${sql.param(cutoff, table.availableAt)}`;",
    ].join("\n")]]);
    const { result } = await diagnose(contents);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      limitations: [expect.stringMatching(/raw Drizzle value interpolation could not be classified/iu)],
    })]);
  });

  it("uses exact adapter imports for applicability and caches discovery reads", async () => {
    const contents = new Map([
      ["src/db.ts", 'import postgres from "postgres";\nimport { drizzle } from "drizzle-orm/postgres-js";'],
      ["src/query.ts", 'import { sql } from "drizzle-orm";\nsql`${new Date()}`;'],
    ]);
    const readFile = reader(contents);
    const { result } = await diagnose(contents, { readFile }, {
      projects: [project([])],
    });

    expect(result.findings).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      "/repo/src/db.ts",
      "/repo/src/query.ts",
    ]);
  });

  it("does not accept similar strings or subpath imports as adapter proof", async () => {
    for (const source of [
      'const adapter = "drizzle-orm/postgres-js";',
      'import { migrate } from "drizzle-orm/postgres-js/migrator";',
      'import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";',
    ]) {
      const contents = new Map([["src/db.ts", source]]);
      const { result } = await diagnose(contents, {}, { projects: [project([])] });
      expect(result.findings).toEqual([]);
      expect(result.coverage).toEqual([expect.objectContaining({ status: "not-applicable" })]);
    }
  });

  it("reports changed scope honestly and uses a changed verification command", async () => {
    const contents = new Map([
      ["src/changed.ts", 'import { sql } from "drizzle-orm";\nsql`${new Date()}`;'],
      ["src/unchanged.ts", 'import { sql } from "drizzle-orm";\nsql`${new Date(1)}`;'],
    ]);
    const { result } = await diagnose(contents, {}, {
      auditScope: changedScope([{ status: "modified", path: "src/changed.ts" }]),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verification?.command).toBe(
      "codebase-doctor audit . --changed --json",
    );
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "completed",
      scope: "changed",
      filesExamined: 1,
      limitations: [
        "Changed scope examined selected current changed files only; unchanged files were not independently re-audited.",
      ],
    })]);
  });

  it("uses an unchanged adapter file as bounded affected-project context in changed mode", async () => {
    const contents = new Map([
      ["src/db.ts", 'import { drizzle } from "drizzle-orm/postgres-js";'],
      ["src/changed.ts", 'import { sql } from "drizzle-orm";\nsql`${new Date()}`;'],
    ]);
    const readFile = reader(contents);
    const { result } = await diagnose(contents, { readFile }, {
      projects: [project([])],
      auditScope: changedScope([{ status: "modified", path: "src/changed.ts" }]),
    });
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      "/repo/src/changed.ts",
      "/repo/src/db.ts",
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location?.path).toBe("src/changed.ts");
    expect(result.coverage).toEqual([expect.objectContaining({ filesExamined: 1 })]);
  });

  it("does not read unaffected project context in changed mode", async () => {
    const contents = new Map([
      ["apps/api/src/db.ts", 'import { drizzle } from "drizzle-orm/postgres-js";'],
      ["apps/api/src/query.ts", 'import { sql } from "drizzle-orm";\nsql`${new Date()}`;'],
      ["apps/web/src/db.ts", 'import { drizzle } from "drizzle-orm/postgres-js";'],
    ]);
    const api = { ...project([]), id: "api", root: "apps/api" };
    const web = { ...project([]), id: "web", root: "apps/web" };
    const readFile = reader(contents);
    const { result } = await diagnose(contents, { readFile }, {
      projects: [api, web],
      auditScope: {
        ...changedScope([{ status: "modified", path: "apps/api/src/query.ts" }]),
        affectedProjectIds: ["api"],
      },
    });

    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      "/repo/apps/api/src/db.ts",
      "/repo/apps/api/src/query.ts",
    ]);
    expect(readFile).not.toHaveBeenCalledWith("/repo/apps/web/src/db.ts");
    expect(result.findings).toHaveLength(1);
  });

  it("returns not-selected when an applicable changed project has no current selected source", async () => {
    const { result } = await diagnose(new Map(), {}, {
      files: [],
      auditScope: changedScope([]),
    });
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "not-selected",
      filesExamined: 0,
    })]);
  });

  it("makes parse failures and read failures partial without leaking exceptions", async () => {
    const contents = new Map([
      ["src/a.ts", 'import { sql } from "drizzle-orm";\nsql`${new Date()}`;'],
      ["src/b.ts", "import {"],
    ]);
    const readFile = reader(contents);
    readFile.mockImplementationOnce(async () => { throw new Error("HOST SECRET"); });
    const { result } = await diagnose(contents, { readFile });
    expect(result.coverage).toEqual([expect.objectContaining({ status: "partial" })]);
    expect(JSON.stringify(result)).not.toContain("HOST SECRET");
    expect(result.findings).toEqual([]);
  });

  it("does not follow a final symlink swapped in after regular-file inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codebase-doctor-drizzle-"));
    const outside = await mkdtemp(join(tmpdir(), "codebase-doctor-outside-"));
    const source = 'import { sql } from "drizzle-orm"; sql`${new Date()}`;';
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(outside, "query.ts"), source);
      await symlink(join(outside, "query.ts"), join(root, "src/query.ts"));
      const doctor = createDrizzleDoctor();
      const result = await doctor.diagnose({
        snapshot: snapshot(new Map(), {
          root,
          files: [file("src/query.ts", source)],
        }),
        allowedCapabilities: new Set(["filesystem:read"]),
      });

      expect(result.findings).toEqual([]);
      expect(result.coverage).toEqual([expect.objectContaining({
        status: "partial",
        filesExamined: 0,
      })]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(source);
      expect(serialized).not.toContain(outside);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("passes a strict allowance to injected readers and rejects growth after cap plus sentinel", async () => {
    const content = 'import { sql } from "drizzle-orm"; sql`${new Date()}`;';
    const contents = new Map([["src/query.ts", content]]);
    const readFile = vi.fn(async (_path: string, allowance: number) =>
      Buffer.alloc(allowance + 1, 0x61)
    );
    const { result } = await diagnose(contents, {
      readFile,
      maxFileBytes: 10,
    }, {
      files: [{ path: "src/query.ts", kind: "file", size: 1 }],
    });

    expect(readFile).toHaveBeenCalledWith("/repo/src/query.ts", 10);
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      filesExamined: 0,
    })]);

    const contractViolation = await diagnose(contents, {
      readFile: async (_path, allowance) =>
        Buffer.concat([Buffer.alloc(allowance + 2), Buffer.from("READER_SECRET")]),
      maxFileBytes: 10,
    }, {
      files: [{ path: "src/query.ts", kind: "file", size: 1 }],
    });
    expect(contractViolation.result.findings).toEqual([]);
    expect(contractViolation.result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      filesExamined: 0,
      limitations: [
        "src/query.ts: bounded source reader exceeded its redacted byte contract; content was rejected.",
      ],
    })]);
    expect(JSON.stringify(contractViolation.result)).not.toContain("READER_SECRET");
  });

  it("rejects invalid UTF-8 before parsing and withholds all source bytes", async () => {
    const sensitive = "SENSITIVE_INVALID_SOURCE";
    const bytes = Buffer.concat([
      Buffer.from('import { sql } from "drizzle-orm"; sql`${new Date()}`;'),
      Buffer.from([0xff]),
      Buffer.from(sensitive),
    ]);
    const contents = new Map([["src/query.ts", "inventory placeholder"]]);
    const { result } = await diagnose(contents, {
      readFile: async (_path, allowance) => bytes.subarray(0, allowance + 1),
      maxFileBytes: bytes.length,
    }, {
      files: [{ path: "src/query.ts", kind: "file", size: bytes.length }],
    });

    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      filesExamined: 0,
      limitations: ["src/query.ts: selected source is not valid UTF-8."],
    })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain("�");
    expect(serialized).not.toContain("new Date");
  });

  it("enforces file and total byte ceilings before analysis", async () => {
    const oversized = new Map([["src/a.ts", "x".repeat(11)]]);
    const tooLarge = await diagnose(oversized, { maxFileBytes: 10 });
    expect(tooLarge.readFile).not.toHaveBeenCalled();
    expect(tooLarge.result.coverage).toEqual([expect.objectContaining({ status: "partial", filesExamined: 0 })]);

    const contents = new Map([
      ["src/a.ts", "123456"],
      ["src/b.ts", "123456"],
    ]);
    const total = await diagnose(contents, { maxTotalBytes: 10 });
    expect(total.readFile).toHaveBeenCalledTimes(1);
    expect(total.result.coverage).toEqual([expect.objectContaining({ status: "partial", filesExamined: 1 })]);
  });

  it("enforces deterministic file and finding ceilings", async () => {
    const contents = new Map([
      ["src/z.ts", 'import { sql } from "drizzle-orm"; sql`${new Date()}`;'],
      ["src/a.ts", 'import { sql } from "drizzle-orm"; sql`${new Date()} ${new Date(1)}`;'],
      ["src/m.ts", 'import { sql } from "drizzle-orm"; sql`${new Date()}`;'],
    ]);
    const limitedFiles = await diagnose(contents, { maxFiles: 2 });
    const limitedReader = limitedFiles.readFile as ReturnType<typeof reader>;
    expect(limitedReader.mock.calls.map(([path]) => path)).toEqual([
      "/repo/src/a.ts",
      "/repo/src/m.ts",
    ]);
    expect(limitedFiles.result.coverage).toEqual([expect.objectContaining({ status: "partial" })]);

    const limitedFindings = await diagnose(contents, { maxFindings: 1 });
    expect(limitedFindings.result.findings).toHaveLength(1);
    expect(limitedFindings.result.findings[0]?.location?.path).toBe("src/a.ts");
    expect(limitedFindings.result.coverage).toEqual([expect.objectContaining({ status: "partial" })]);
  });

  it("streams a large reverse-ordered inventory and retains only earliest file paths", async () => {
    const contents = new Map(Array.from({ length: 250 }, (_, index) => {
      const ordinal = 249 - index;
      return [`src/file-${String(ordinal).padStart(3, "0")}.ts`, "export {};\n"] as const;
    }));
    const readFile = reader(contents);
    const { result } = await diagnose(contents, { readFile, maxFiles: 3 });
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      "/repo/src/file-000.ts",
      "/repo/src/file-001.ts",
      "/repo/src/file-002.ts",
    ]);
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      filesExamined: 3,
      limitations: expect.arrayContaining([
        "Drizzle source file limit of 3 was reached; 247 current supported file(s) were not discovered or analyzed.",
      ]),
    })]);
  });

  it("bounds limitation memory and reports exact omitted duplicate occurrences", async () => {
    const content = "xx";
    const contents = new Map([["src/repeated.ts", content]]);
    const repeated = Array.from({ length: 25 }, () => file("src/repeated.ts", content));
    const readFile = reader(contents);
    const { result } = await diagnose(contents, {
      readFile,
      maxFileBytes: 1,
      maxFiles: 30,
      maxLimitations: 1,
    }, { files: repeated });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.coverage).toEqual([expect.objectContaining({
      status: "partial",
      limitations: ["src/repeated.ts: file exceeds the 1-byte Drizzle audit size limit."],
      limitationSummary: { total: 25, emitted: 1, omitted: 24 },
    })]);
  });

  it("rejects invalid bound overrides", () => {
    for (const options of [
      { maxFileBytes: 0 },
      { maxTotalBytes: -1 },
      { maxFiles: 1.5 },
      { maxFindings: Number.POSITIVE_INFINITY },
      { maxLimitations: 0 },
    ]) {
      expect(() => createDrizzleDoctor(options)).toThrow(/positive safe integer/iu);
    }
  });
});
