#!/usr/bin/env node
/**
 * Rival differential — run codebase-doctor and independently installed rival
 * scanners (Semgrep, gitleaks, Trivy, osv-scanner) over the same seeded
 * corpus and publish an honest per-case scoreboard.
 *
 * Unlike `npm run benchmark`, this harness is not a pass/fail gate. Rival
 * scanners are not deterministic (rule registries and advisory databases
 * move), so results are a dated, versioned snapshot: where each tool caught
 * the seeded defect, where it missed, and how much noise it added on clean
 * controls. Not-evaluated cells are defects outside that rival's documented
 * scope — never counted as misses.
 *
 * Usage:
 *   npm run rival-differential                        # console table + JSON
 *   npm run rival-differential -- --only secrets-tracked,sql-concat
 *   npm run rival-differential -- --out results.json --markdown docs/rival-scoreboard.md
 *
 * Missing rivals are skipped and named in the output; install them with
 * pinned versions (see docs/rival-scoreboard.md for the exact commands).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CASES,
  commitAll,
  makeRepo,
  runCli,
  token,
  write,
} from "./benchmark-corpus.mjs";

const require = createRequire(import.meta.url);
const CBD_VERSION = require("../package.json").version;

const TOOL_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Pre-registered evaluation matrix. A `catch` cell claims the rival documents
 * coverage for that defect class at the pinned version; a miss is reported as
 * a miss. `informational` cells still run and report finding counts, without
 * a verdict, because the class is outside the rival's documented scope.
 * Anything absent is not run for that case.
 */
const EVALUATIONS = {
  "secrets-tracked": { gitleaks: "catch", trivy: "catch", semgrep: "catch" },
  "secrets-realistic-token": { gitleaks: "catch", trivy: "catch", semgrep: "catch" },
  "secrets-history": { gitleaks: "catch" },
  "secrets-history-realistic": { gitleaks: "catch" },
  "import-missing": {},
  "docker-unpinned": { trivy: "catch", semgrep: "catch" },
  "workflow-injection": { trivy: "informational", semgrep: "informational" },
  "a11y-img": { semgrep: "informational" },
  "cors-wildcard": { semgrep: "informational" },
  "build-artifact": {},
  "sql-concat": { semgrep: "catch" },
  "child-exec": { semgrep: "catch" },
  "dangerous-html": { semgrep: "informational" },
  "python-insecure-git": {},
  "python-missing-lock": {},
  "python-drift": {},
  "vulnerable-lockfile": { osv: "catch", trivy: "informational", semgrep: "informational" },
  "review-request-changes": { gitleaks: "catch", trivy: "catch", semgrep: "catch" },
  "review-approve": { gitleaks: "informational", trivy: "informational", semgrep: "informational" },
  "suppression-honesty": { gitleaks: "informational", trivy: "informational", semgrep: "informational" },
  "control-minimal": {},
  "control-fixed-lockfile": { osv: "noise-control", trivy: "noise-control", semgrep: "noise-control", gitleaks: "noise-control" },
};

/**
 * Rival-only cases: defect classes the CBD corpus does not seed because they
 * are inherently offline-advisory or noise baselines. CBD runs on every case
 * too, so its output is directly comparable.
 */
const RIVAL_ONLY_CASES = [
  {
    name: "secrets-realistic-token",
    defect: "Provider token at realistic provider length",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "config.ts", `const API_KEY = "${token("ghp_", 36)}";\n`);
      commitAll(root, "add config");
    },
  },
  {
    name: "secrets-history-realistic",
    defect: "Realistic-length token committed then removed",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "config.ts", `const API_KEY = "${token("ghp_", 36)}";\n`);
      commitAll(root, "add credential");
      write(root, "config.ts", "export const clean = true;\n");
      commitAll(root, "remove credential");
    },
  },
  {
    name: "vulnerable-lockfile",
    defect: "Known-vulnerable dependency pinned in a lockfile",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({
        name: "bench",
        private: true,
        dependencies: { lodash: "4.17.20" },
      }, null, 2));
      write(root, "package-lock.json", JSON.stringify({
        name: "bench",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "bench", dependencies: { lodash: "4.17.20" } },
          "node_modules/lodash": {
            version: "4.17.20",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
            integrity: "sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA==",
          },
        },
      }, null, 2));
      commitAll(root, "add vulnerable lockfile");
    },
  },
  {
    name: "control-minimal",
    defect: "No defect (clean baseline for noise)",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({ name: "clean", private: true }));
      write(root, "src/index.ts", "export const value = 1;\n");
      commitAll(root, "clean baseline");
    },
  },
  {
    name: "control-fixed-lockfile",
    defect: "Advisory-clean dependency (second clean baseline for noise)",
    command: ["audit", "--json", "--fail-on", "none"],
    setup(root) {
      write(root, "package.json", JSON.stringify({
        name: "clean",
        private: true,
        dependencies: { ms: "2.1.3" },
      }, null, 2));
      write(root, "package-lock.json", JSON.stringify({
        name: "clean",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "clean", dependencies: { ms: "2.1.3" } },
          "node_modules/ms": {
            version: "2.1.3",
            resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
            integrity: "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
          },
        },
      }, null, 2));
      commitAll(root, "advisory-clean lockfile baseline");
    },
  },
];

const DEFECT_CLASSES = {
  "secrets-tracked": "Provider token committed to the working tree",
  "secrets-history": "Token removed from the tree but live in git history (non-provider format)",
  "import-missing": "Relative import target missing",
  "docker-unpinned": "Dockerfile base image without a pinned tag",
  "workflow-injection": "Untrusted event data interpolated into a workflow run step",
  "a11y-img": "img element without alt text",
  "cors-wildcard": "CORS wildcard origin combined with credentials",
  "build-artifact": "Committed build artifact",
  "sql-concat": "SQL query built by string concatenation",
  "child-exec": "Shell command built by string concatenation",
  "dangerous-html": "dangerouslySetInnerHTML with dynamic HTML",
  "python-insecure-git": "Dependency sourced over plain HTTP git",
  "python-missing-lock": "Manifest without a lockfile",
  "python-drift": "Manifest/lockfile version drift",
  "review-request-changes": "Secret introduced in a diff",
  "review-approve": "Secret present but untouched in the diff (diff-scope control)",
  "suppression-honesty": "Acknowledged secret via inline suppression",
  ...Object.fromEntries(RIVAL_ONLY_CASES.map((def) => [def.name, def.defect])),
};

/**
 * Rival registry. Binaries can be overridden with RIVAL_<ID>_BIN so CI can
 * point at pinned installs without touching PATH.
 */
/**
 * Cases that exercise dependency advisories. codebase-doctor consults OSV
 * only through the opt-in network flag `--with-advisories`, so those cases
 * get a second, capability-aware run; everything else stays offline.
 */
const ADVISORY_CASES = new Set(["vulnerable-lockfile", "control-fixed-lockfile"]);

const RIVALS = [
  {
    id: "semgrep",
    label: "Semgrep CE",
    binary: "semgrep",
    envVar: "SEMGREP_BIN",
    versionArgs: ["--version"],
    note: "Public registry rulesets (p/default, p/secrets, p/dockerfile); login-gated and Pro rules are excluded.",
    run(root, scratch) {
      return {
        args: [
          "scan", "--json", "--quiet", "--metrics=off",
          "--config", "p/default", "--config", "p/secrets", "--config", "p/dockerfile",
          root,
        ],
        parse(stdout) {
          const report = JSON.parse(stdout);
          return (report.results ?? []).map((entry) => entry.check_id ?? "unknown");
        },
      };
    },
  },
  {
    id: "gitleaks",
    label: "gitleaks",
    binary: "gitleaks",
    envVar: "GITLEAKS_BIN",
    versionArgs: ["version"],
    note: "History mode uses `gitleaks git`; uncommitted diffs use `gitleaks dir`.",
    run(root, scratch, def) {
      const reportPath = join(scratch, "gitleaks.json");
      const mode = def.name === "review-request-changes" ? "dir" : "git";
      return {
        args: [mode, root, "--report-format", "json", "--report-path", reportPath, "--no-banner", "--exit-code", "0"],
        parse() {
          const raw = readFileSync(reportPath, "utf8");
          const entries = JSON.parse(raw === "" ? "[]" : raw);
          return (Array.isArray(entries) ? entries : []).map((entry) => entry.RuleID ?? "unknown");
        },
      };
    },
  },
  {
    id: "trivy",
    label: "Trivy",
    binary: "trivy",
    envVar: "TRIVY_BIN",
    versionArgs: ["--version"],
    note: "secret,misconfig scanners; the vulnerability database is not exercised here.",
    run(root, scratch) {
      const cacheDir = join(scratch, "trivy-cache");
      return {
        args: [
          "fs", "--scanners", "secret,misconfig", "--format", "json", "--quiet",
          "--cache-dir", cacheDir, root,
        ],
        parse(stdout) {
          const report = JSON.parse(stdout);
          const rules = [];
          for (const result of report.Results ?? []) {
            for (const secret of result.Secrets ?? []) rules.push(secret.RuleID ?? "secret");
            for (const misconfig of result.Misconfigurations ?? []) rules.push(misconfig.ID ?? "misconfig");
          }
          return rules;
        },
      };
    },
  },
  {
    id: "osv",
    label: "osv-scanner",
    binary: "osv-scanner",
    envVar: "OSV_SCANNER_BIN",
    versionArgs: ["--version"],
    note: "Queries the OSV advisory database over the network; scans lockfiles only.",
    run(root) {
      return {
        args: ["scan", "source", "--recursive", "--format", "json", root],
        parse(stdout) {
          if (stdout.trim() === "") return [];
          const report = JSON.parse(stdout);
          const rules = [];
          for (const result of report.results ?? []) {
            for (const pkg of result.packages ?? []) {
              for (const vuln of pkg.vulnerabilities ?? []) {
                rules.push(vuln.id ?? "vulnerability");
              }
            }
          }
          return rules;
        },
      };
    },
  },
];

function binaryFor(rival) {
  return process.env[rival.envVar] ?? rival.binary;
}

function detectRival(rival) {
  const binary = binaryFor(rival);
  const cleanVersion = (text) => {
    const match = /\d+\.\d+\.\d+/u.exec(text);
    return match === null ? text.trim() : match[0];
  };
  try {
    const stdout = execFileSync(binary, rival.versionArgs, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { installed: true, binary, version: cleanVersion(stdout) };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    if (stdout !== "") {
      return { installed: true, binary, version: cleanVersion(stdout) };
    }
    return { installed: false, binary, version: null };
  }
}

function runRival(rival, def, root, scratch) {
  const started = Date.now();
  const { args, parse } = rival.run(root, scratch, def);
  const binary = binaryFor(rival);
  try {
    const stdout = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rules = parse(stdout, root, scratch);
    return { status: "ran", findings: rules.length, rules, durationMs: Date.now() - started };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    if (stdout.trim() !== "") {
      try {
        const rules = parse(stdout, root, scratch);
        return { status: "ran", findings: rules.length, rules, durationMs: Date.now() - started };
      } catch {
        // Fall through to the error result below.
      }
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim().split("\n").slice(-1)[0] ?? "" : "";
    return {
      status: "error",
      findings: 0,
      rules: [],
      detail: stderr === "" ? String(error.message ?? error) : stderr,
      durationMs: Date.now() - started,
    };
  }
}

function runCodebaseDoctor(def, root, extraArgs = []) {
  const run = runCli([def.command[0], root, ...def.command.slice(1), ...extraArgs], root);
  try {
    const report = JSON.parse(run.stdout);
    const findings = report.findings ?? [];
    return {
      status: "ran",
      findings: findings.length,
      rules: findings.map((finding) => finding.ruleId),
    };
  } catch {
    return { status: "error", findings: 0, rules: [], detail: "unparseable output" };
  }
}

function evaluateCase(def, rivals) {
  const root = makeRepo(def.setup, "rival-differential-");
  const scratch = mkdtempSync(join(tmpdir(), "rival-differential-scratch-"));
  try {
    const cbd = runCodebaseDoctor(def, root);
    const cbdAdvisories = ADVISORY_CASES.has(def.name)
      ? runCodebaseDoctor(def, root, ["--with-advisories"])
      : { status: "not-evaluated", findings: 0, rules: [] };
    const results = {};
    for (const rival of rivals) {
      const expectation = (EVALUATIONS[def.name] ?? {})[rival.id];
      if (expectation === undefined) {
        results[rival.id] = { status: "not-evaluated" };
        continue;
      }
      results[rival.id] = { ...runRival(rival, def, root, scratch), expectation };
    }
    return { name: def.name, defect: DEFECT_CLASSES[def.name], cbd, cbdAdvisories, rivals: results };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

function verdictCell(result) {
  if (result === undefined || result.status === "not-evaluated") return "n/e";
  if (result.status === "error") return "error";
  if (result.expectation === "noise-control") return result.findings === 0 ? "clean" : `noise:${result.findings}`;
  if (result.expectation === "catch") return result.findings > 0 ? "caught" : "missed";
  return result.findings > 0 ? `flagged:${result.findings}` : "quiet";
}

function summarize(caseResults, rivals) {
  return rivals.map((rival) => {
    const cells = caseResults.map((entry) => entry.rivals[rival.id]).filter((cell) => cell !== undefined);
    const catchCells = cells.filter((cell) => cell.expectation === "catch" && cell.status === "ran");
    const noiseCells = cells.filter((cell) => cell.expectation === "noise-control" && cell.status === "ran");
    const informational = cells.filter((cell) => cell.expectation === "informational" && cell.status === "ran");
    return {
      id: rival.id,
      label: rival.label,
      evaluated: catchCells.length,
      caught: catchCells.filter((cell) => cell.findings > 0).length,
      missed: catchCells.filter((cell) => cell.findings === 0).length,
      noiseBaselines: noiseCells.length,
      noiseFindings: noiseCells.reduce((sum, cell) => sum + cell.findings, 0),
      informationalFlagged: informational.filter((cell) => cell.findings > 0).length,
      informationalTotal: informational.length,
      errors: cells.filter((cell) => cell.status === "error").length,
      notes: rival.note,
    };
  });
}

function markdownReport({ caseResults, summaries, rivalInfo, generatedAt }) {
  const lines = [];
  const statusIcon = (cell) => {
    switch (cell) {
      case "caught": return "✅ caught";
      case "missed": return "❌ missed";
      case "n/e": return "— n/e";
      case "clean": return "✅ clean";
      case "error": return "⚠️ error";
      default: return cell.startsWith("noise:") ? `🔶 ${cell}` : cell.startsWith("flagged:") ? `🔶 ${cell}` : cell;
    }
  };
  lines.push(`# Rival scanner scoreboard — ${generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push("Generated by `npm run rival-differential`. This is a **dated snapshot**, not a gate:");
  lines.push("rival rule registries and advisory databases move, so numbers are reproduced with the");
  lines.push("versions below, not compared across dates.");
  lines.push("");
  lines.push("| Tool | Version |");
  lines.push("| --- | --- |");
  lines.push(`| codebase-doctor | ${CBD_VERSION} |`);
  for (const info of rivalInfo) {
    lines.push(`| ${info.label} | ${info.installed ? info.version : "not installed (skipped)"} |`);
  }
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push("- Every case is a disposable git repository seeded with exactly the defect class in its row.");
  lines.push("- Cells are pre-registered: ✅/❌ where the rival documents coverage for that class;");
  lines.push("  `flagged`/`quiet` (🔶) where the class is outside its documented scope; `n/e` where no");
  lines.push("  evaluation applies. `noise:` counts findings on clean baselines — those are false-positive");
  lines.push("  signals for the rival, not defects.");
  lines.push("- Fixtures are codebase-doctor's corpus; rival sensitivity on synthetic tokens can differ");
  lines.push("  from real-world credentials and is reported, not concealed.");
  lines.push("- The `(+advisories)` column is codebase-doctor run with the opt-in `--with-advisories`");
  lines.push("  network flag (OSV, point-in-time). It is evaluated only on the dependency cases and");
  lines.push("  `n/e` elsewhere; the default column stays fully offline and deterministic.");
  lines.push("");
  lines.push("## Per-case matrix");
  lines.push("");
  lines.push("| Case | Defect class | codebase-doctor | codebase-doctor (+advisories) | Semgrep CE | gitleaks | Trivy | osv-scanner |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of caseResults) {
    const cbdCell = entry.cbd.status === "ran"
      ? (entry.cbd.findings > 0 ? `flagged:${entry.cbd.findings}` : "quiet")
      : "error";
    const advisoryCell = entry.cbdAdvisories.status === "not-evaluated"
      ? "— n/e"
      : entry.cbdAdvisories.status === "ran"
        ? (entry.cbdAdvisories.findings > 0 ? `flagged:${entry.cbdAdvisories.findings}` : "quiet")
        : "⚠️ error";
    const cells = ["semgrep", "gitleaks", "trivy", "osv"].map((id) =>
      statusIcon(verdictCell(entry.rivals[id]))
    );
    lines.push(`| \`${entry.name}\` | ${entry.defect} | ${cbdCell} | ${advisoryCell} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Rival | Caught (evaluated) | Missed | Findings on clean controls | Informational flags | Errors |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.label} | ${summary.caught} / ${summary.evaluated} | ${summary.missed} | ` +
      `${summary.noiseFindings} | ${summary.informationalFlagged} / ${summary.informationalTotal} | ${summary.errors} |`,
    );
  }
  lines.push("");
  lines.push("## What this shows, including where codebase-doctor loses");
  lines.push("");
  lines.push("- `vulnerable-lockfile`: osv-scanner catches known-vulnerable dependencies from the OSV");
  lines.push("  database, and codebase-doctor catches the same class only in the opt-in `(+advisories)`");
  lines.push("  column. Offline-by-default is a deliberate trade: deterministic audits never call the");
  lines.push("  network, so the default column shows the capability gap and the advisory column shows");
  lines.push("  the fix. For supply-chain vulns in routine use, enable `--with-advisories` or run the");
  lines.push("  rival first.");
  lines.push("- `secrets-history` (original fixture): the seeded `github_pat_` value is not a");
  lines.push("  provider-valid format (fine-grained PATs are longer), so provider-format linters miss it");
  lines.push("  while codebase-doctor's relaxed detector catches it. `secrets-history-realistic` gives");
  lines.push("  rivals a realistic-length token in history and shows gitleaks catching the same class.");
  lines.push("- Check the informational columns for classes rivals flag that codebase-doctor does not and");
  lines.push("  vice versa. Cases with no engaged rival are codebase-doctor-unique coverage in this");
  lines.push("  corpus, not proof of superiority.");
  lines.push("");
  lines.push("## Rival setup (pinned for reproduction)");
  lines.push("");
  lines.push("```bash");
  lines.push("# gitleaks");
  lines.push("curl -sL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz | tar xz -C /usr/local/bin gitleaks");
  lines.push("# Trivy");
  lines.push("curl -sL https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz | tar xz -C /usr/local/bin trivy");
  lines.push("# osv-scanner");
  lines.push("curl -sL -o /usr/local/bin/osv-scanner https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_amd64");
  lines.push("# Semgrep (public registry rulesets; semgrep login unlocks more rules and changes results)");
  lines.push("pipx install semgrep==1.180.0");
  lines.push("```");
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  lines.push("- Semgrep CE without `semgrep login` runs a reduced public ruleset; its real-world recall is");
  lines.push("  higher than this snapshot shows. The pinned version and rule source are recorded above.");
  lines.push("- Rival scanners target different threat models; `n/e` cells are outside-scope classes, not");
  lines.push("  defeats. Severities are not normalized across tools and no attempt is made to rank them.");
  lines.push("- 21 synthetic fixtures cannot represent a real repository's noise profile. The clean-control");
  lines.push("  rows are the honest noise signal available at this size.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  const only = flag("--only");
  const out = flag("--out");
  const markdown = flag("--markdown");

  try {
    execFileSync(process.execPath, [join(new URL("..", import.meta.url).pathname, "dist", "cli.js"), "--version"], { stdio: "ignore" });
  } catch {
    console.error("rival-differential: dist/cli.js is not runnable; run `npm run build` first.");
    process.exitCode = 2;
    return;
  }

  const rivalInfo = RIVALS.map((rival) => ({ ...rival, ...detectRival(rival) }));
  const installed = rivalInfo.filter((info) => info.installed);
  const skipped = rivalInfo.filter((info) => !info.installed);
  for (const info of skipped) {
    console.log(`rival-differential: ${info.label} is not installed; skipping (set ${info.envVar} to a binary path).`);
  }

  const selectedNames = only === null ? null : new Set(only.split(","));
  const allCases = [...CASES, ...RIVAL_ONLY_CASES];
  const selected = selectedNames === null ? allCases : allCases.filter((def) => selectedNames.has(def.name));
  if (selected.length === 0) {
    console.error(`rival-differential: no cases match ${only ?? ""}`);
    process.exitCode = 2;
    return;
  }

  const caseResults = selected.map((def) => evaluateCase(def, installed));
  const summaries = summarize(caseResults, installed);

  for (const entry of caseResults) {
    const cells = installed
      .map((rival) => `${rival.id}=${verdictCell(entry.rivals[rival.id])}`)
      .join(" ");
    const advisory = entry.cbdAdvisories.status === "ran" ? ` cbd+advisories=${entry.cbdAdvisories.findings}` : "";
    console.log(`case ${entry.name}: cbd=${entry.cbd.status === "ran" ? entry.cbd.findings : "error"}${advisory} ${cells}`);
  }
  console.log("");
  for (const summary of summaries) {
    console.log(
      `rival ${summary.label}: caught ${summary.caught}/${summary.evaluated}, missed ${summary.missed}, ` +
      `clean-control findings ${summary.noiseFindings}, informational flags ${summary.informationalFlagged}/${summary.informationalTotal}, errors ${summary.errors}`,
    );
  }
  if (skipped.length > 0) {
    console.log(`skipped (not installed): ${skipped.map((info) => info.label).join(", ")}`);
  }

  const generatedAt = new Date().toISOString();
  if (out !== null) {
    writeFileSync(resolve(out), `${JSON.stringify({
      tool: "codebase-doctor-rival-differential",
      generatedAt,
      codebaseDoctorVersion: CBD_VERSION,
      rivals: rivalInfo.map(({ id, label, version, installed }) => ({ id, label, version, installed })),
      cases: caseResults,
      summaries,
    }, null, 2)}\n`);
    console.log(`rival-differential: wrote ${out}`);
  }
  if (markdown !== null) {
    writeFileSync(resolve(markdown), markdownReport({ caseResults, summaries, rivalInfo, generatedAt }));
    console.log(`rival-differential: wrote ${markdown}`);
  }
}

main();
