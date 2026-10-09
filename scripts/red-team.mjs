#!/usr/bin/env node
/**
 * Red-team self-play: adversarial mutations of the benchmark's seeded
 * defects. Each case is one of:
 *
 *   mutant  — the defect is real and statically decidable; the audit MUST
 *             still find the expected rule. A miss is an evasion (defense
 *             gap) and fails the run.
 *   control — a safe or recommended pattern; the audit MUST NOT report the
 *             rule. A hit is a false positive and fails the run.
 *
 * Mutations that are undecidable offline (base64, runtime assembly,
 * extensionless specifiers) are deliberately out of scope and documented in
 * docs/red-team.md — this harness never demands guesses.
 *
 * Usage:
 *   npm run build && node scripts/red-team.mjs [--out results.json] [--only a,b] [--list]
 */
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

function makeRepo(setup) {
  const root = mkdtempSync(join(tmpdir(), "codebase-doctor-redteam-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "--local", "user.name", "RedTeam"]);
  git(root, ["config", "--local", "user.email", "redteam@example.invalid"]);
  setup(root);
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", "fixture"]);
  return root;
}

function runCli(root) {
  const started = Date.now();
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, "audit", ".", "--json", "--fail-on", "none"], {
      cwd: root,
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

const TOKEN = token("ghp_");
const PINNED_DIGEST = "a".repeat(64);

const CASES = [
  {
    name: "secrets-json-config",
    kind: "mutant",
    rule: "security/secrets/provider-token",
    setup(root) {
      write(root, "config.json", `{\n  "apiKey": "${TOKEN}"\n}\n`);
    },
  },
  {
    name: "secrets-comment",
    kind: "mutant",
    rule: "security/secrets/provider-token",
    setup(root) {
      write(root, "src/auth.ts", `// temporary credential: ${TOKEN}\nexport const value = 1;\n`);
    },
  },
  {
    name: "secrets-tracked-env",
    kind: "mutant",
    rule: "security/secrets/provider-token",
    setup(root) {
      write(root, ".env", `API_KEY=${TOKEN}\n`);
    },
  },
  {
    name: "secrets-placeholder-control",
    kind: "control",
    rule: "security/secrets/provider-token",
    setup(root) {
      write(root, "config.ts", `const API_KEY = "ghp_example_placeholder_value";\n`);
    },
  },
  {
    name: "import-reexport",
    kind: "mutant",
    rule: "source/import-target-missing",
    setup(root) {
      write(root, "src/api.ts", `export { getUser } from "./missing.js";\n`);
    },
  },
  {
    name: "import-dynamic-literal",
    kind: "mutant",
    rule: "source/import-target-missing",
    setup(root) {
      write(root, "src/loader.ts", `export async function load() {\n  return import("./missing.js");\n}\n`);
    },
  },
  {
    name: "import-require",
    kind: "mutant",
    rule: "source/import-target-missing",
    setup(root) {
      write(root, "src/legacy.cjs", `const missing = require("./missing.js");\nmodule.exports = { missing };\n`);
    },
  },
  {
    name: "import-clean-control",
    kind: "control",
    rule: "source/import-target-missing",
    setup(root) {
      write(root, "src/lib.ts", `export const value = 1;\n`);
      write(root, "src/app.ts", `import { value } from "./lib.js";\nexport const result = value;\n`);
    },
  },
  {
    name: "workflow-injection-pull-request",
    kind: "mutant",
    rule: "infrastructure/github-actions/script-injection",
    setup(root) {
      write(
        root,
        ".github/workflows/ci.yml",
        [
          "name: ci",
          "on: [pull_request]",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo \"${{ github.event.pull_request.title }}\"",
          "",
        ].join("\n"),
      );
    },
  },
  {
    name: "workflow-env-indirection-control",
    kind: "control",
    rule: "infrastructure/github-actions/script-injection",
    setup(root) {
      write(
        root,
        ".github/workflows/ci.yml",
        [
          "name: ci",
          "on: [pull_request]",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo \"$TITLE\"",
          "        env:",
          "          TITLE: ${{ github.event.pull_request.title }}",
          "",
        ].join("\n"),
      );
    },
  },
  {
    name: "docker-untagged-base",
    kind: "mutant",
    rule: "infrastructure/docker/unpinned-base-image",
    setup(root) {
      write(root, "Dockerfile", "FROM ubuntu\nRUN echo hello\n");
    },
  },
  {
    name: "docker-digest-pinned-control",
    kind: "control",
    rule: "infrastructure/docker/unpinned-base-image",
    setup(root) {
      write(root, "Dockerfile", `FROM node:22-slim@sha256:${PINNED_DIGEST}\nRUN echo hello\n`);
    },
  },
  {
    name: "a11y-tsx-missing-alt",
    kind: "mutant",
    rule: "frontend/accessibility/img-missing-alt",
    setup(root) {
      write(root, "src/Logo.tsx", `export function Logo() {\n  return <img src="/logo.png" />;\n}\n`);
    },
  },
  {
    name: "a11y-alt-control",
    kind: "control",
    rule: "frontend/accessibility/img-missing-alt",
    setup(root) {
      write(root, "src/Logo.tsx", `export function Logo() {\n  return <img src="/logo.png" alt="Logo" />;\n}\n`);
    },
  },
  {
    name: "sql-string-concat",
    kind: "mutant",
    rule: "backend/api/sql-string-concat-query",
    setup(root) {
      write(
        root,
        "src/db.ts",
        `import { Pool } from "pg";\nconst pool = new Pool();\nexport function find(id: string) {\n  return pool.query("select * from users where id = '" + id + "'");\n}\n`,
      );
    },
  },
  {
    name: "sql-parameterized-control",
    kind: "control",
    rule: "backend/api/sql-string-concat-query",
    setup(root) {
      write(
        root,
        "src/db.ts",
        `import { Pool } from "pg";\nconst pool = new Pool();\nexport function find(id: string) {\n  return pool.query("select * from users where id = $1", [id]);\n}\n`,
      );
    },
  },
  {
    name: "child-exec-template",
    kind: "mutant",
    rule: "backend/api/child-process-exec-dynamic",
    setup(root) {
      write(
        root,
        "src/run.ts",
        `import { exec } from "node:child_process";\nexport function run(name: string) {\n  return exec(\`echo \${name}\`);\n}\n`,
      );
    },
  },
  {
    name: "child-execfile-control",
    kind: "control",
    rule: "backend/api/child-process-exec-dynamic",
    setup(root) {
      write(
        root,
        "src/run.ts",
        `import { execFile } from "node:child_process";\nexport function run(name: string) {\n  return execFile("echo", [name]);\n}\n`,
      );
    },
  },
];

function evaluate(def) {
  const root = makeRepo(def.setup);
  try {
    const run = runCli(root);
    let report = null;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      return { name: def.name, kind: def.kind, rule: def.rule, pass: false, reason: "unparseable output", durationMs: run.durationMs };
    }
    const rules = (report.findings ?? []).map((finding) => finding.ruleId);
    const detected = rules.includes(def.rule);
    const pass = def.kind === "mutant" ? detected : !detected;
    return {
      name: def.name,
      kind: def.kind,
      rule: def.rule,
      pass,
      detected,
      reason: pass
        ? "ok"
        : def.kind === "mutant"
          ? `evasion: ${def.rule} not reported`
          : `false-positive: ${def.rule} reported on a safe pattern`,
      durationMs: run.durationMs,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex === -1 ? null : new Set(argv[onlyIndex + 1].split(","));
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? null : resolve(argv[outIndex + 1]);

  if (argv.includes("--list")) {
    for (const def of CASES) console.log(`${def.kind}\t${def.name}\t${def.rule}`);
    return;
  }

  try {
    execFileSync(process.execPath, [CLI, "--version"], { stdio: "ignore" });
  } catch {
    console.error("red-team: dist/cli.js is not runnable; run `npm run build` first.");
    process.exitCode = 2;
    return;
  }

  const selected = CASES.filter((def) => only === null || only.has(def.name));
  if (selected.length === 0) {
    console.error(`red-team: no cases match ${[...(only ?? [])].join(",")}`);
    process.exitCode = 2;
    return;
  }

  const results = selected.map(evaluate);
  const mutants = results.filter(({ kind }) => kind === "mutant");
  const controls = results.filter(({ kind }) => kind === "control");
  const caught = mutants.filter(({ pass }) => pass).length;
  const clean = controls.filter(({ pass }) => pass).length;
  const totalDuration = results.reduce((sum, { durationMs }) => sum + durationMs, 0);

  for (const result of results) {
    const mark = result.pass ? "PASS" : "FAIL";
    const label = result.kind === "mutant" ? "mutant" : "control";
    console.log(`${mark} ${label} ${result.name} (${result.durationMs}ms) :: ${result.reason}`);
  }
  console.log(
    `\nred-team: ${caught}/${mutants.length} mutants caught, ${clean}/${controls.length} controls clean ` +
    `in ${totalDuration}ms (defense regressions fail this run; undecidable mutations are out of scope, see docs/red-team.md)`,
  );

  if (out !== null) {
    writeFileSync(out, `${JSON.stringify({
      tool: "codebase-doctor-red-team",
      results,
      mutants: { total: mutants.length, caught },
      controls: { total: controls.length, clean },
      totalDurationMs: totalDuration,
    }, null, 2)}\n`);
    console.log(`red-team: wrote ${out}`);
  }

  process.exitCode = results.every(({ pass }) => pass) ? 0 : 1;
}

main();
