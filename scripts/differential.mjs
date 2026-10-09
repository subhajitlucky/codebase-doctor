#!/usr/bin/env node
/**
 * Doctors verifying Doctors: differential scoreboard.
 *
 * Runs codebase-doctor's offline `database/sql-rls` analyzer and rls-doctor's
 * offline schema-file analyzer over the same SQL corpus, then publishes:
 *
 *   - per-fixture agreement (matched findings, only-A, only-B)
 *   - severity mismatches on matched findings
 *   - a rule coverage matrix (which doctor implements which rule)
 *
 * Divergence is information, not failure: the scoreboard exists to make
 * implementation drift visible instead of hiding it. Exit code is 0 unless
 * the harness itself cannot run.
 *
 * Usage:
 *   npm run build && node scripts/differential.mjs [--out results.json] [--format markdown]
 *   RLS_DOCTOR_PATH=/path/to/rls-doctor node scripts/differential.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repositoryRoot, "dist", "cli.js");
const CORPUS = join(repositoryRoot, "test", "fixtures", "sql-corpus");
const RLS_DOCTOR_PATH = process.env.RLS_DOCTOR_PATH ?? resolve(repositoryRoot, "..", "rls-doctor");

function git(root, args) {
  execFileSync("git", [
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd: root, stdio: "ignore" });
}

function runCodebaseDoctor(sql) {
  const root = mkdtempSync(join(tmpdir(), "codebase-doctor-differential-"));
  try {
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(root, "supabase", "migrations", "0001_init.sql"), sql, "utf8");
    git(root, ["init", "--quiet"]);
    git(root, ["config", "--local", "user.name", "Differential"]);
    git(root, ["config", "--local", "user.email", "differential@example.invalid"]);
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", "fixture"]);
    const stdout = execFileSync(
      process.execPath,
      [CLI, "audit", ".", "--json", "--fail-on", "none"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", DATABASE_URL: "", SUPABASE_DB_URL: "" },
      },
    );
    const report = JSON.parse(stdout);
    return (report.findings ?? [])
      .filter((finding) => typeof finding.ruleId === "string" && finding.ruleId.startsWith("database/sql-rls/"))
      .map((finding) => {
        const evidence = (finding.evidence ?? []).find((entry) => entry.type === "database");
        const location = evidence === undefined
          ? ""
          : ` ${evidence.schema ?? ""}${evidence.table === undefined ? "" : `.${evidence.table}`}`;
        return {
          rule: finding.ruleId.split("/").pop(),
          key: `${finding.ruleId.split("/").pop()}${location}`,
          severity: finding.severity,
        };
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runRlsDoctor(sql) {
  const indexPath = join(RLS_DOCTOR_PATH, "dist", "index.js");
  if (!existsSync(indexPath)) {
    throw new Error(
      `rls-doctor build not found at ${indexPath}; build it or set RLS_DOCTOR_PATH.`,
    );
  }
  const { parseSchemaSql, analyzeCatalog } = await import(pathToFileURL(indexPath).href);
  const parsed = parseSchemaSql(sql);
  const report = analyzeCatalog(parsed.snapshot, {
    schemas: parsed.schemas,
    limitations: parsed.limitations,
  });
  const findings = [
    ...report.schemaFindings.map((finding) => ({
      rule: finding.id,
      key: `${finding.id} ${finding.schema ?? ""}`,
      severity: finding.severity,
    })),
    ...report.tables.flatMap((table) =>
      table.findings.map((finding) => ({
        rule: finding.id,
        key: `${finding.id} ${finding.schema}.${finding.table}`,
        severity: finding.severity,
      }))),
  ];
  return findings;
}

function compare(codebaseFindings, rlsFindings) {
  const codebaseKeys = new Map(codebaseFindings.map((finding) => [finding.key, finding]));
  const rlsKeys = new Map(rlsFindings.map((finding) => [finding.key, finding]));
  const matched = [...codebaseKeys.keys()].filter((key) => rlsKeys.has(key)).sort();
  const onlyCodebase = [...codebaseKeys.keys()].filter((key) => !rlsKeys.has(key)).sort();
  const onlyRls = [...rlsKeys.keys()].filter((key) => !codebaseKeys.has(key)).sort();
  const severityMismatches = matched
    .filter((key) => codebaseKeys.get(key).severity !== rlsKeys.get(key).severity)
    .map((key) => ({
      key,
      codebase: codebaseKeys.get(key).severity,
      rls: rlsKeys.get(key).severity,
    }));
  return { matched, onlyCodebase, onlyRls, severityMismatches };
}

async function main() {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? null : resolve(argv[outIndex + 1]);
  const markdown = argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "markdown";

  if (!existsSync(CLI)) {
    console.error("differential: dist/cli.js is not runnable; run `npm run build` first.");
    process.exitCode = 2;
    return;
  }

  const fixtures = ["unsafe.sql", "safe.sql", "defaults-and-roles.sql"];
  const results = [];
  const codebaseRules = new Set();
  const rlsRules = new Set();

  for (const fixture of fixtures) {
    const sql = readFileSync(join(CORPUS, fixture), "utf8");
    const codebaseFindings = runCodebaseDoctor(sql);
    const rlsFindings = await runRlsDoctor(sql);
    for (const finding of codebaseFindings) codebaseRules.add(finding.rule);
    for (const finding of rlsFindings) rlsRules.add(finding.rule);
    results.push({
      fixture,
      codebase: codebaseFindings.length,
      rls: rlsFindings.length,
      ...compare(codebaseFindings, rlsFindings),
    });
  }

  const allRules = [...new Set([...codebaseRules, ...rlsRules])].sort();
  const coverage = allRules.map((rule) => ({
    rule,
    codebase: codebaseRules.has(rule),
    rls: rlsRules.has(rule),
  }));
  const totals = results.reduce(
    (accumulator, result) => ({
      matched: accumulator.matched + result.matched.length,
      onlyCodebase: accumulator.onlyCodebase + result.onlyCodebase.length,
      onlyRls: accumulator.onlyRls + result.onlyRls.length,
      severityMismatches: accumulator.severityMismatches + result.severityMismatches.length,
    }),
    { matched: 0, onlyCodebase: 0, onlyRls: 0, severityMismatches: 0 },
  );

  if (markdown) {
    console.log(renderMarkdown(results, coverage, totals));
  } else {
    for (const result of results) {
      console.log(
        `${result.fixture}: codebase=${result.codebase} rls=${result.rls} matched=${result.matched.length} ` +
        `only-codebase=${result.onlyCodebase.length} only-rls=${result.onlyRls.length} ` +
        `severity-mismatches=${result.severityMismatches.length}`,
      );
      for (const key of result.onlyCodebase) console.log(`  only-codebase: ${key}`);
      for (const key of result.onlyRls) console.log(`  only-rls:      ${key}`);
      for (const mismatch of result.severityMismatches) {
        console.log(`  severity:      ${mismatch.key} (codebase ${mismatch.codebase} vs rls ${mismatch.rls})`);
      }
    }
    console.log(
      `\ndifferential: ${totals.matched} matched, ${totals.onlyCodebase} only-codebase, ` +
      `${totals.onlyRls} only-rls, ${totals.severityMismatches} severity mismatch(es) ` +
      `across ${fixtures.length} fixture(s)`,
    );
  }

  if (out !== null) {
    writeFileSync(out, `${JSON.stringify({
      tool: "doctor-differential",
      fixtures: results,
      coverage,
      totals,
    }, null, 2)}\n`);
    console.log(`differential: wrote ${out}`);
  }
}

function renderMarkdown(results, coverage, totals) {
  const lines = [
    "| Fixture | codebase-doctor | rls-doctor | matched | only-codebase | only-rls | severity mismatches |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| \`${result.fixture}\` | ${result.codebase} | ${result.rls} | ${result.matched.length} | ` +
      `${result.onlyCodebase.length} | ${result.onlyRls.length} | ${result.severityMismatches.length} |`,
    );
  }
  lines.push(
    "",
    `Totals: **${totals.matched} matched**, ${totals.onlyCodebase} only-codebase, ` +
    `${totals.onlyRls} only-rls, ${totals.severityMismatches} severity mismatch(es).`,
    "",
    "| Rule | codebase-doctor | rls-doctor |",
    "| --- | --- | --- |",
  );
  for (const entry of coverage) {
    lines.push(`| \`${entry.rule}\` | ${entry.codebase ? "yes" : "—"} | ${entry.rls ? "yes" : "—"} |`);
  }
  return lines.join("\n");
}

await main();
