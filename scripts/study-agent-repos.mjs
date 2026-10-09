#!/usr/bin/env node
/**
 * Ecosystem study: audit public repositories that carry agent configuration
 * files (AGENTS.md / CLAUDE.md) as a proxy for agent-involved development.
 * Clones shallow copies into a temp directory, runs the real Codebase Doctor
 * audit, and emits aggregate, anonymized results only — see
 * docs/disclosure-policy.md.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/study-agent-repos.mjs [--limit 100] [--max-size 30000] [--out results.json]
 *
 * Requires `npm run build` first (uses dist/cli.js).
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("study: GITHUB_TOKEN is required (public repo read scope).");
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const limit = Number(flag("--limit", "100"));
const maxSizeKb = Number(flag("--max-size", "30000"));
const out = flag("--out", null);
const QUERIES = ["filename:AGENTS.md", "filename:CLAUDE.md"];
const EXCLUDED_OWNER = "subhajitlucky";

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "codebase-doctor-study",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchRepositories() {
  const repositories = new Map();
  for (const query of QUERIES) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`code search failed (${response.status})`);
    const body = await response.json();
    for (const item of body.items ?? []) {
      const repository = item.repository;
      if (repository === undefined || repository.fork === true) continue;
      if (repository.owner?.login === EXCLUDED_OWNER) continue;
      repositories.set(repository.full_name, { fullName: repository.full_name });
    }
    await sleep(7_000);
  }
  return [...repositories.values()];
}

async function repositoryMetadata(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository.fullName}`, { headers });
  if (!response.ok) throw new Error(`metadata failed (${response.status})`);
  const body = await response.json();
  return {
    fullName: repository.fullName,
    defaultBranch: body.default_branch,
    sizeKb: body.size ?? 0,
    cloneUrl: body.clone_url,
  };
}

async function auditRepository(metadata) {
  const root = await mkdtemp(join(tmpdir(), "codebase-doctor-study-"));
  try {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--quiet", metadata.cloneUrl, root],
      { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 4 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(process.cwd(), "dist", "cli.js"), "audit", ".", "--format", "json", "--fail-on", "none"],
      {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", DATABASE_URL: "", SUPABASE_DB_URL: "" },
      },
    );
    const report = JSON.parse(stdout);
    const findings = (report.findings ?? []).map((finding) => ({
      id: finding.ruleId,
      severity: finding.severity,
    }));
    return {
      sizeKb: metadata.sizeKb,
      score: report.score?.value ?? null,
      files: report.projects?.flatMap((project) => project.files ?? []).length ?? null,
      findings,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function aggregate(records) {
  const analyzed = records.filter((record) => record.error === undefined);
  const withRule = (id) => analyzed.filter((record) => record.findings.some((finding) => finding.id === id)).length;
  const severityCounts = {};
  for (const record of analyzed) {
    for (const finding of record.findings) {
      severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
    }
  }
  const ruleCounts = new Map();
  for (const record of analyzed) {
    const seen = new Set(record.findings.map((finding) => finding.id));
    for (const id of seen) ruleCounts.set(id, (ruleCounts.get(id) ?? 0) + 1);
  }
  const scores = analyzed.map((record) => record.score).filter((score) => score !== null);
  const averageScore = scores.length === 0
    ? null
    : Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);

  return {
    repositoriesSelected: records.length,
    repositoriesAnalyzed: analyzed.length,
    repositoriesFailed: records.length - analyzed.length,
    reposWithCommittedSecret: withRule("security/secrets/provider-token"),
    reposWithBrokenImport: withRule("source/import-target-missing"),
    averageScore,
    severityCounts,
    topRules: [...ruleCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
      .slice(0, 12),
  };
}

async function main() {
  const repositories = await searchRepositories();
  console.log(`study: ${repositories.length} repositories selected from ${QUERIES.join(" + ")}`);

  const records = [];
  for (const [index, repository] of repositories.entries()) {
    if (records.filter((record) => record.error === undefined).length >= limit) break;
    const record = { index };
    try {
      const metadata = await repositoryMetadata(repository);
      if (metadata.sizeKb > maxSizeKb) {
        records.push({ ...record, error: `skipped: repo size ${metadata.sizeKb}KB` });
        continue;
      }
      const analysis = await auditRepository(metadata);
      records.push({ ...record, ...analysis });
      console.log(
        `study: [${records.length}] analyzed ${metadata.sizeKb}KB: ` +
        `${analysis.findings.length} findings, score ${analysis.score}`,
      );
    } catch (error) {
      records.push({ ...record, error: error instanceof Error ? error.message : String(error) });
      console.log(`study: [${records.length}] skipped (${records.at(-1).error})`);
    }
  }

  const summary = aggregate(records);
  console.log("\nstudy summary (aggregate, anonymized):");
  console.log(JSON.stringify(summary, null, 2));

  if (out !== null) {
    writeFileSync(out, `${JSON.stringify({ queries: QUERIES, summary, records }, null, 2)}\n`);
    console.log(`\nstudy: wrote anonymized results to ${out}`);
  }
}

await main();
