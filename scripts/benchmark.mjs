import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CASES, CLI, makeRepo, runCli } from "./benchmark-corpus.mjs";

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
      expected: def.expect ?? [],
      unexpected,
      verdictExpected: def.verdict ?? null,
      suppressedExpected: def.suppressed ?? [],
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
  const expectedRules = results.reduce((sum, { expected }) => sum + expected.length, 0);
  const matchedRules = results.reduce(
    (sum, { expected, found }) => sum + expected.filter((rule) => (found ?? []).includes(rule)).length,
    0,
  );
  const falsePositives = results.reduce((sum, { unexpected }) => sum + unexpected.length, 0);
  const reviewCases = results.filter(({ verdictExpected }) => verdictExpected !== null);
  const suppressionCases = results.filter(({ suppressedExpected }) => suppressedExpected.length > 0);
  const summary = {
    recall: { expected: expectedRules, matched: matchedRules },
    falsePositives,
    review: {
      cases: reviewCases.length,
      passed: reviewCases.filter(({ pass }) => pass).length,
    },
    suppression: {
      cases: suppressionCases.length,
      passed: suppressionCases.filter(({ pass }) => pass).length,
    },
    runtimeMs: totalDuration,
  };

  for (const result of results) {
    const mark = result.pass ? "PASS" : "FAIL";
    console.log(
      `${mark} ${result.name} (${result.durationMs}ms) :: ${result.reason} :: found=[${(result.found ?? []).join(", ")}]`,
    );
  }
  console.log(
    `\nbenchmark: ${passed}/${results.length} cases passed in ${totalDuration}ms ` +
    `(recall ${summary.recall.matched}/${summary.recall.expected}, medium+ false positives ${summary.falsePositives}, ` +
    `review ${summary.review.passed}/${summary.review.cases}, suppression ${summary.suppression.passed}/${summary.suppression.cases}; ` +
    `verify-resolved is covered at unit level because live coverage cannot complete offline)`,
  );

  if (out !== null) {
    writeFileSync(out, `${JSON.stringify({
      tool: "codebase-doctor-benchmark",
      cases: results,
      passed,
      total: results.length,
      totalDurationMs: totalDuration,
      summary,
    }, null, 2)}\n`);
    console.log(`benchmark: wrote ${out}`);
  }
  process.exitCode = passed === results.length ? 0 : 1;
}

await main();
