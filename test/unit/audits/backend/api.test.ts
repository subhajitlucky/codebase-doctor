import { describe, expect, it } from "vitest";
import { analyzeBackendApi } from "../../../../src/audits/backend/api/doctor.js";

describe("backend/api SQL analysis", () => {
  it("flags concatenated query text on a bound pool instance", () => {
    const analysis = analyzeBackendApi(
      "db.js",
      [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        'export function byId(id) { return pool.query("SELECT * FROM users WHERE id = " + id); }',
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings.map(({ ruleId }) => ruleId)).toEqual([
      "backend/api/sql-string-concat-query",
    ]);
    expect(analysis.findings[0]).toMatchObject({ severity: "high", confidence: "high" });
  });

  it("flags interpolated templates and accepts parameterized queries", () => {
    const interpolated = analyzeBackendApi(
      "db.js",
      [
        'const mysql = require("mysql2");',
        "const connection = new mysql.Connection();",
        "export function byId(id) { return connection.execute(`SELECT * FROM users WHERE id = ${id}`); }",
        "",
      ].join("\n"),
      false,
    );
    expect(interpolated.findings.map(({ ruleId }) => ruleId)).toEqual([
      "backend/api/sql-string-concat-query",
    ]);

    const parameterized = analyzeBackendApi(
      "db.js",
      [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        'export function byId(id) { return pool.query("SELECT * FROM users WHERE id = $1", [id]); }',
        'export function all() { return pool.query("SELECT * FROM users"); }',
        "",
      ].join("\n"),
      false,
    );
    expect(parameterized.findings).toEqual([]);
    expect(parameterized.limitations).toEqual([]);
  });

  it("withholds judgment on unresolvable query text", () => {
    const analysis = analyzeBackendApi(
      "db.js",
      [
        'import { Pool } from "pg";',
        "const pool = new Pool();",
        "export function run(sql) { return pool.query(sql); }",
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings).toEqual([]);
    expect(analysis.limitations.join(" ")).toContain("could not be resolved statically");
  });

  it("never flags an unrelated local query helper", () => {
    const analysis = analyzeBackendApi(
      "db.js",
      [
        "function query(sql) { return cache.get(sql); }",
        'export function run(id) { return query("SELECT * FROM users WHERE id = " + id); }',
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings).toEqual([]);
  });
});

describe("backend/api child_process analysis", () => {
  it("flags dynamic shell commands and accepts static or separated invocations", () => {
    const dynamic = analyzeBackendApi(
      "run.js",
      [
        'const { exec } = require("child_process");',
        'export function list(dir) { exec("ls " + dir); }',
        "",
      ].join("\n"),
      false,
    );
    expect(dynamic.findings.map(({ ruleId }) => ruleId)).toEqual([
      "backend/api/child-process-exec-dynamic",
    ]);

    const safe = analyzeBackendApi(
      "run.js",
      [
        'const { exec, execFile, spawn } = require("child_process");',
        'export function a() { exec("ls -la"); }',
        'export function b(dir) { execFile("ls", [dir]); }',
        'export function c(dir) { spawn("ls", [dir]); }',
        "",
      ].join("\n"),
      false,
    );
    expect(safe.findings).toEqual([]);
  });

  it("flags spawn with an explicit shell option", () => {
    const analysis = analyzeBackendApi(
      "run.js",
      [
        'import { spawn } from "node:child_process";',
        'export function list(dir) { spawn("ls " + dir, { shell: true }); }',
        "",
      ].join("\n"),
      false,
    );

    expect(analysis.findings.map(({ ruleId }) => ruleId)).toEqual([
      "backend/api/child-process-exec-dynamic",
    ]);
  });

  it("reports unparseable sources as limitations", () => {
    const analysis = analyzeBackendApi("run.js", "export function (broken", false);

    expect(analysis.findings).toEqual([]);
    expect(analysis.limitations.join(" ")).toContain("could not be parsed");
  });
});
