import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repositoryRoot, "dist", "cli.js");

const ALPHABET = "M7n9B2v8C4x6Z1l3K5j0HgFdSaPqWeRt";
function token(prefix, length = 32) {
  let value = prefix;
  for (let index = 0; value.length < prefix.length + length; index += 1) {
    value += ALPHABET[index % ALPHABET.length];
  }
  return value;
}

function git(root, args) {
  execFileSync("git", [
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd: root, stdio: "ignore" });
}

function write(root, path, content) {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function runCli(args, root) {
  const started = Date.now();
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", DATABASE_URL: "", SUPABASE_DB_URL: "" },
    });
  } catch (error) {
    status = typeof error.status === "number" ? error.status : 2;
    stdout = typeof error.stdout === "string" ? error.stdout : "";
  }
  return { status, stdout, durationMs: Date.now() - started };
}

function makeRepo(setup) {
  const root = mkdtempSync(join(tmpdir(), "codebase-doctor-bench-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "--local", "user.name", "Benchmark"]);
  git(root, ["config", "--local", "user.email", "bench@example.invalid"]);
  setup(root);
  return root;
}

function commitAll(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", message]);
}

/**
 * Benchmark cases: each seeds one defect class into a disposable git
 * repository and asserts the deterministic audit outcome. Only medium+
 * findings outside the expected set count as false positives; info/low
 * hygiene noise (e.g. no-visible-tests) is reported separately.
 */
const CASES = [
  {
    name: "secrets-tracked",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "config.ts", `const API_KEY = "${token("ghp_")}";\n`);
      commitAll(root, "add config");
    },
    expect: ["security/secrets/provider-token"],
    exit: 0,
  },
  {
    name: "secrets-history",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "config.ts", `const API_KEY = "${token("github_pat_")}";\n`);
      commitAll(root, "add credential");
      write(root, "config.ts", "export const clean = true;\n");
      commitAll(root, "remove credential");
    },
    expect: ["security/secrets-history/provider-token"],
    exit: 0,
  },
  {
    name: "import-missing",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "bench", private: true }));
      write(root, "src/a.ts", 'import "./missing.ts";\n');
      commitAll(root, "add sources");
    },
    expect: ["source/import-target-missing"],
    exit: 0,
  },
  {
    name: "docker-unpinned",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "Dockerfile", "FROM node\n");
      commitAll(root, "add dockerfile");
    },
    expect: ["infrastructure/docker/unpinned-base-image"],
    exit: 0,
  },
  {
    name: "workflow-injection",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(
        root,
        ".github/workflows/ci.yml",
        [
          "name: ci",
          "on: [push]",
          "jobs:",
          "  run:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo ${{ github.event.issue.title }}",
          "",
        ].join("\n"),
      );
      commitAll(root, "add workflow");
    },
    expect: ["infrastructure/github-actions/script-injection"],
    exit: 0,
  },
  {
    name: "a11y-img",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(
        root,
        "index.html",
        [
          '<!DOCTYPE html>',
          '<html lang="en">',
          "<head><title>Bench</title>",
          '<meta name="description" content="Benchmark fixture page."></head>',
          '<body><img src="a.png"></body></html>',
          "",
        ].join("\n"),
      );
      commitAll(root, "add page");
    },
    expect: ["frontend/accessibility/img-missing-alt"],
    exit: 0,
  },
  {
    name: "cors-wildcard",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "bench", private: true }));
      write(
        root,
        "server.js",
        [
          'const cors = require("cors");',
          'const express = require("express");',
          "const app = express();",
          'app.use(cors({ origin: "*", credentials: true }));',
          "",
        ].join("\n"),
      );
      commitAll(root, "add server");
    },
    expect: ["backend/auth/cors-wildcard-origin-with-credentials"],
    exit: 0,
  },
  {
    name: "build-artifact",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "bench", private: true }));
      write(root, "vendor/app.min.js", `"${"x".repeat(600_000)}";\n`);
      commitAll(root, "commit vendored bundle");
    },
    expect: ["performance/static/committed-build-artifact"],
    exit: 0,
  },
  {
    name: "sql-concat",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "bench", private: true }));
      write(
        root,
        "db.js",
        [
          'import { Pool } from "pg";',
          "const pool = new Pool();",
          'export function byId(id) { return pool.query("SELECT * FROM users WHERE id = " + id); }',
          "",
        ].join("\n"),
      );
      commitAll(root, "add query");
    },
    expect: ["backend/api/sql-string-concat-query"],
    exit: 0,
  },
  {
    name: "child-exec",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "bench", private: true }));
      write(
        root,
        "run.js",
        [
          'const { exec } = require("child_process");',
          'export function list(dir) { exec("ls " + dir); }',
          "",
        ].join("\n"),
      );
      commitAll(root, "add runner");
    },
    expect: ["backend/api/child-process-exec-dynamic"],
    exit: 0,
  },
  {
    name: "dangerous-html",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "bench", private: true }));
      write(
        root,
        "page.tsx",
        [
          "export function Page({ html }: { html: string }) {",
          "  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
          "}",
          "",
        ].join("\n"),
      );
      commitAll(root, "add page");
    },
    expect: ["frontend/security/dangerously-set-inner-html"],
    exit: 0,
  },
  {
    name: "python-insecure-git",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "pyproject.toml", [
        "[project]",
        'name = "bench"',
        'dependencies = ["requests>=2"]',
        "",
      ].join("\n"));
      write(root, "poetry.lock", [
        "[[package]]",
        'name = "requests"',
        'version = "2.31.0"',
        'files = [{file = "r.whl", hash = "sha256:x"}]',
        "",
        "[[package]]",
        'name = "evil"',
        'version = "1.0"',
        "",
        "[package.source]",
        'type = "git"',
        'url = "http://git.example.invalid/evil.git"',
        'reference = "main"',
        "",
      ].join("\n"));
      commitAll(root, "add python graph");
    },
    expect: [
      "security/dependencies/insecure-source",
      "security/dependencies/mutable-git-source",
    ],
    exit: 0,
  },
  {
    name: "python-missing-lock",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "pyproject.toml", [
        "[project]",
        'name = "bench"',
        'dependencies = ["requests>=2"]',
        "",
      ].join("\n"));
      commitAll(root, "add manifest without lock");
    },
    expect: ["security/dependencies/missing-lockfile"],
    exit: 0,
  },
  {
    name: "python-drift",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "pyproject.toml", [
        "[tool.poetry.dependencies]",
        'python = ">=3.9"',
        'requests = "==1.0"',
        "",
      ].join("\n"));
      write(root, "poetry.lock", [
        "[[package]]",
        'name = "requests"',
        'version = "2.31.0"',
        'files = [{file = "r.whl", hash = "sha256:x"}]',
        "",
      ].join("\n"));
      commitAll(root, "add drifting graph");
    },
    expect: ["security/dependencies/manifest-lock-drift"],
    exit: 0,
  },
  {
    name: "review-request-changes",
    command: ["review", "--format", "json", "--fail-on", "high"],
    setup(root) {
      write(root, "ok.ts", "export const value = 1;\n");
      commitAll(root, "base");
      write(root, "changed.ts", `const GITHUB_TOKEN = "${token("ghp_")}";\n`);
    },
    expect: ["security/secrets/provider-token"],
    verdict: "REQUEST_CHANGES",
    exit: 1,
  },
  {
    name: "review-approve",
    command: ["review", "--format", "json", "--fail-on", "high"],
    setup(root) {
      const secret = token("ghp_");
      write(root, "app.ts", `const GITHUB_TOKEN = "${secret}";\nexport const value = 1;\n`);
      commitAll(root, "base");
      write(root, "app.ts", `const GITHUB_TOKEN = "${secret}";\nexport const value = 2;\n`);
    },
    expect: [],
    verdict: "APPROVE",
    exit: 0,
  },
  {
    name: "suppression-honesty",
    command: ["audit", "--json", "--fail-on", "high"],
    setup(root) {
      write(
        root,
        "config.ts",
        `const API_KEY = "${token("ghp_")}"; // codebase-doctor-ignore: security/secrets/provider-token -- rotated\n`,
      );
      commitAll(root, "acknowledged credential");
    },
    expect: [],
    suppressed: ["security/secrets/provider-token"],
    exit: 0,
  },
];

function evaluate(def) {
  const root = makeRepo(def.setup);
  try {
    const run = runCli([def.command[0], root, ...def.command.slice(1)], root);
    let report = null;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      return { name: def.name, pass: false, reason: "unparseable output", durationMs: run.durationMs };
    }
    const rules = (report.findings ?? []).map((finding) => finding.ruleId);
    const missing = (def.expect ?? []).filter((rule) => !rules.includes(rule));
    const unexpected = rules.filter((rule) => {
      if ((def.expect ?? []).includes(rule)) return false;
      const severity = (report.findings ?? []).find((finding) => finding.ruleId === rule)?.severity;
      return severity === "critical" || severity === "high" || severity === "medium";
    });
    const suppressedRules = (report.suppressed ?? []).map((entry) => entry.ruleId);
    const suppressedMissing = (def.suppressed ?? []).filter((rule) => !suppressedRules.includes(rule));
    const verdictOk = def.verdict === undefined ||
      (report.review?.verdict ?? report.verdict) === def.verdict;
    const exitOk = run.status === def.exit;
    const pass = missing.length === 0 && unexpected.length === 0 &&
      suppressedMissing.length === 0 && verdictOk && exitOk;
    const reasons = [];
    if (missing.length > 0) reasons.push(`missed: ${missing.join(", ")}`);
    if (unexpected.length > 0) reasons.push(`false-positives: ${unexpected.join(", ")}`);
    if (suppressedMissing.length > 0) reasons.push(`suppressed-missing: ${suppressedMissing.join(", ")}`);
    if (!verdictOk) reasons.push(`verdict: ${report.review?.verdict}`);
    if (!exitOk) reasons.push(`exit: ${run.status}`);
    return {
      name: def.name,
      pass,
      reason: reasons.join("; ") || "ok",
      found: rules,
      durationMs: run.durationMs,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const onlyIndex = argv.indexOf("--cases");
  const only = onlyIndex === -1 ? null : new Set(argv[onlyIndex + 1].split(","));
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? null : resolve(argv[outIndex + 1]);

  try {
    execFileSync(process.execPath, [CLI, "--version"], { stdio: "ignore" });
  } catch {
    console.error("benchmark: dist/cli.js is not runnable; run `npm run build` first.");
    process.exitCode = 2;
    return;
  }

  const selected = CASES.filter((def) => only === null || only.has(def.name));
  if (selected.length === 0) {
    console.error(`benchmark: no cases match ${[...(only ?? [])].join(",")}`);
    process.exitCode = 2;
    return;
  }

  const results = selected.map(evaluate);
  const passed = results.filter(({ pass }) => pass).length;
  const totalDuration = results.reduce((sum, { durationMs }) => sum + durationMs, 0);

  for (const result of results) {
    const mark = result.pass ? "PASS" : "FAIL";
    console.log(
      `${mark} ${result.name} (${result.durationMs}ms) :: ${result.reason} :: found=[${(result.found ?? []).join(", ")}]`,
    );
  }
  console.log(
    `\nbenchmark: ${passed}/${results.length} cases passed in ${totalDuration}ms ` +
    `(recall and medium+ false-positive rate on seeded single-defect fixtures; ` +
    `verify-resolved is covered at unit level because live coverage cannot complete offline)`,
  );

  if (out !== null) {
    writeFileSync(out, `${JSON.stringify({
      tool: "codebase-doctor-benchmark",
      cases: results,
      passed,
      total: results.length,
      totalDurationMs: totalDuration,
    }, null, 2)}\n`);
    console.log(`benchmark: wrote ${out}`);
  }
  process.exitCode = passed === results.length ? 0 : 1;
}

await main();
