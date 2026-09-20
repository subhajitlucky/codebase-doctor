import { Command } from "commander";
import { loadBaseline } from "../core/baseline.js";
import type { ScanRequest } from "../core/scan.js";
import { classifyVerifyExit, verifyRepairs } from "../core/verify.js";
import {
  renderVerifyBrief,
  renderVerifyJson,
  renderVerifyText,
} from "../reporters/verify.js";
import {
  configureRepositoryCommand,
  runRepositoryScan,
  type RepositoryCommandOptions,
} from "./scan.js";

interface VerifyCommandOptions extends RepositoryCommandOptions {
  allowUnchanged: boolean;
}

type VerifyOutputFormat = "text" | "json" | "brief";

const VERIFY_FORMATS = new Set<VerifyOutputFormat>(["text", "json", "brief"]);

function parseVerifyFormat(options: VerifyCommandOptions): VerifyOutputFormat {
  const format = options.format ?? (options.json ? "json" : "text");
  if (!VERIFY_FORMATS.has(format as VerifyOutputFormat)) {
    throw new Error(
      `Invalid verify output format "${format}": expected text, json, or brief.`,
    );
  }
  if (options.json && options.format !== undefined && options.format !== "json") {
    throw new Error("The --json and --format options conflict.");
  }
  return format as VerifyOutputFormat;
}

async function executeVerify(
  path: string,
  options: VerifyCommandOptions,
  requestOptions: () => Partial<ScanRequest> = () => ({}),
): Promise<void> {
  try {
    if (options.baseline === undefined) {
      throw new Error(
        "verify requires --baseline <path> pointing at a prior schema-1 JSON report.",
      );
    }

    const baseline = await loadBaseline(options.baseline);
    const { baseline: _ignored, ...scanOptions } = options;
    const { result, failOn } = await runRepositoryScan(path, scanOptions, requestOptions);
    const verification = verifyRepairs(baseline.findings, result);
    const format = parseVerifyFormat(options);

    const report =
      format === "json"
        ? renderVerifyJson(verification)
        : format === "brief"
          ? renderVerifyBrief(verification)
          : renderVerifyText(verification);
    process.stdout.write(report);

    process.exitCode = classifyVerifyExit(verification, failOn, {
      allowUnchanged: options.allowUnchanged,
    });

    if (options.requireComplete && !verification.coverageComplete) {
      process.stderr.write(
        "codebase-doctor: audit coverage is incomplete and --require-complete was set; failing with exit code 2.\n",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codebase-doctor: ${message}\n`);
    process.exitCode = 2;
  }
}

export function createVerifyCommand(): Command {
  return configureRepositoryCommand<VerifyCommandOptions>(
    new Command("verify").description(
      "Verify that baseline findings were repaired under completed coverage.",
    ).option(
      "--allow-unchanged",
      "do not fail when baseline findings are still present",
      false,
    ),
    () => ({}),
    executeVerify,
  );
}
