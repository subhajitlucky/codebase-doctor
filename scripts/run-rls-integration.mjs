#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);

if (process.env.CODEBASE_DOCTOR_ALLOW_DESTRUCTIVE_TESTS !== "1") {
  throw new Error(
    "Refusing to load destructive fixtures. Set " +
    "CODEBASE_DOCTOR_ALLOW_DESTRUCTIVE_TESTS=1 only for this disposable Docker test.",
  );
}

const containerName = `codebase-doctor-${randomUUID()}`;
const postgresVersion = process.env.POSTGRES_VERSION ?? "16";
const password = randomBytes(24).toString("base64url");
const auditorRole = `codebase_doctor_auditor_${randomBytes(8).toString("hex")}`;
let adminUrl;
let auditorUrl;

try {
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=codebase_doctor",
    "-p",
    "127.0.0.1::5432",
    `postgres:${postgresVersion}`,
  ]);

  const mapping = (await docker(["port", containerName, "5432/tcp"])).trim();
  const port = mapping.slice(mapping.lastIndexOf(":") + 1);
  if (!/^\d+$/.test(port)) {
    throw new Error(`Docker returned an invalid PostgreSQL port mapping: ${mapping}`);
  }

  adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/codebase_doctor`;
  await waitForPostgres(adminUrl);
  auditorUrl = await prepareDatabase(adminUrl);

  const unsafe = await runAudit(auditorUrl, "rls_doctor_demo");
  assertEqual(unsafe.code, 1, "unsafe audit threshold exit");
  assertEqual(unsafe.stderr, "", "unsafe audit stderr");
  assertNoCredentials(unsafe);
  const unsafeReport = JSON.parse(unsafe.stdout);
  assertFinding(unsafeReport, {
    ruleId: "database/rls/rls-disabled-exposed",
    severity: "high",
    schema: "rls_doctor_demo",
    table: "orders",
  });
  assertFinding(unsafeReport, {
    ruleId: "database/rls/reachable-truncate",
    severity: "high",
    schema: "rls_doctor_demo",
    table: "profiles",
  });
  assertFinding(unsafeReport, {
    ruleId: "database/rls/broad-default-table-privilege",
    severity: "high",
    schema: "rls_doctor_demo",
  });

  const safe = await runAudit(auditorUrl, "rls_doctor_demo_safe");
  assertEqual(safe.code, 0, "safe audit threshold exit");
  assertEqual(safe.stderr, "", "safe audit stderr");
  assertNoCredentials(safe);
  const safeReport = JSON.parse(safe.stdout);
  assertEqual(safeReport.summary.counts.high, 0, "safe high findings");
  assertEqual(safeReport.summary.counts.critical, 0, "safe critical findings");
  assertEqual(
    safeReport.doctorRuns.find(({ doctorId }) => doctorId === "database/rls")?.status,
    "completed",
    "safe RLS doctor status",
  );

  console.log(`Unified RLS integration passed on PostgreSQL ${postgresVersion}.`);
} catch (error) {
  throw new Error(redact(error instanceof Error ? error.message : String(error)));
} finally {
  await docker(["rm", "-f", containerName]).catch(() => undefined);
}

async function prepareDatabase(connectionString) {
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    for (const fixture of ["unsafe-schema.sql", "safe-schema.sql"]) {
      const sql = await readFile(
        new URL(`../test/fixtures/rls/${fixture}`, import.meta.url),
        "utf8",
      );
      await admin.query(sql);
    }
    await admin.query(`create role ${quoteIdentifier(auditorRole)} login password '${password}'`);
    const database = (await admin.query("select current_database() as name")).rows[0].name;
    await admin.query(
      `grant connect on database ${quoteIdentifier(database)} to ${quoteIdentifier(auditorRole)}`,
    );
    return withCredentials(connectionString, auditorRole, password);
  } finally {
    await admin.end();
  }
}

async function runAudit(connectionString, schema) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "dist/cli.js",
        "audit",
        "test/fixtures/node-pass",
        "--with-database",
        "--database-schema",
        schema,
        "--json",
        "--fail-on",
        "high",
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
          SUPABASE_DB_URL: "",
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      return {
        code: typeof error.code === "number" ? error.code : 2,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : String(error),
      };
    }
    return { code: 2, stdout: "", stderr: String(error) };
  }
}

function assertFinding(report, expected) {
  const found = report.findings.some((finding) => {
    const evidence = finding.evidence.find(({ type }) => type === "database");
    return Object.entries(expected).every(([key, value]) =>
      key === "schema" || key === "table"
        ? evidence?.[key] === value
        : finding[key] === value
    );
  });
  assert(found, `Unsafe audit did not produce ${JSON.stringify(expected)}`);
}

function assertNoCredentials(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of [adminUrl, auditorUrl, password, auditorRole]) {
    if (secret) assert(!output.includes(secret), "Audit output exposed database credentials.");
  }
}

async function waitForPostgres(connectionString) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Timed out waiting for disposable PostgreSQL.");
}

async function docker(args) {
  try {
    return (await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    const diagnostic = typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr).trim()
      : String(error);
    throw new Error(`Docker command failed: ${redact(diagnostic)}`);
  }
}

function withCredentials(value, username, userPassword) {
  const url = new URL(value);
  url.username = username;
  url.password = userPassword;
  return url.toString();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function redact(value) {
  let result = value.replaceAll("postgres:postgres", "[REDACTED_ADMIN]");
  for (const secret of [adminUrl, auditorUrl, password, auditorRole]) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${expected}, received ${actual}`);
}
