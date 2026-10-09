import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import type { ScanResult } from "../core/normalize.js";
import { auditCodebase } from "../core/scan.js";
import { parseIntents } from "../intent/parse.js";
import { buildIntentReport, evaluateIntent, renderIntentText } from "../intent/verify.js";
import { VERSION } from "../version.js";

interface VerifyIntentOptions {
  report?: string;
  out?: string;
  json: boolean;
  requireVerified: boolean;
}

function isAuditReport(value: unknown): value is ScanResult {
  return (
    typeof value === "object" && value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === "1" &&
    Array.isArray((value as { findings?: unknown }).findings) &&
    Array.isArray((value as { domainCoverage?: unknown }).domainCoverage)
  );
}

export function createIntentCommand(): Command {
  const intent = new Command("intent").description(
    "Verify declared intent (structured claims) against audit evidence.",
  );

  intent
    .command("verify")
    .description(
      "Check declared claims — verified, violated, or undecided — with coverage honesty.",
    )
    .argument("<intent-file>", "JSON intent document or markdown with ```intent blocks")
    .argument("[path]", "repository path to audit when --report is not given", ".")
    .option("--report <path>", "reuse an existing schema-1 audit JSON report")
    .option("--out <path>", "write the intent report artifact (canonical JSON with digest)")
    .option("--require-verified", "exit 2 when any claim is undecided", false)
    .option("--json", "emit machine-readable JSON", false)
    .action(async (intentFile: string, path: string, options: VerifyIntentOptions) => {
      try {
        const intentText = await readFile(intentFile, "utf8");
        const parsed = parseIntents(intentText, intentFile);

        let result: ScanResult;
        if (options.report !== undefined) {
          let value: unknown;
          try {
            value = JSON.parse(await readFile(options.report, "utf8"));
          } catch {
            throw new Error(`${options.report} is not valid JSON.`);
          }
          if (!isAuditReport(value)) {
            throw new Error(`${options.report} is not a schema-1 Codebase Doctor report.`);
          }
          result = value;
        } else {
          result = await auditCodebase({
            root: path,
            runChecks: false,
            format: "text",
            timeoutMs: 120_000,
            failOn: "none",
            includeDatabaseAudit: true,
            includeSecurityAudit: true,
          });
        }

        const claimResults = evaluateIntent(parsed.claims, result);
        const report = buildIntentReport(
          claimResults,
          {
            path: options.report === undefined ? path : result.repository.root,
            intentSource: intentFile,
          },
          parsed.unstructuredCharacters,
          VERSION,
        );

        if (options.out !== undefined) {
          await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
          process.stderr.write(`codebase-doctor: intent report written to ${options.out}\n`);
        }
        process.stdout.write(
          options.json ? `${JSON.stringify(report, null, 2)}\n` : renderIntentText(report),
        );

        if (report.summary.violated > 0) {
          process.exitCode = 1;
        } else if (options.requireVerified && report.summary.undecided > 0) {
          process.exitCode = 2;
          process.stderr.write(
            "codebase-doctor: --require-verified rejected undecided claims; coverage must be complete to verify them.\n",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });

  return intent;
}
