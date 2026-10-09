import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { parseThreshold } from "./scan.js";
import { runShadow, type ShadowFormat } from "../shadow/runner.js";

const SHADOW_FORMATS = new Set<ShadowFormat>(["text", "brief", "json"]);

interface ShadowCommandOptions {
  runChecks: boolean;
  format: string;
  failOn: string;
  receipt?: string;
  receiptKey?: string;
}

export function createShadowCommand(): Command {
  return new Command("shadow")
    .description(
      "Audit a disposable copy of the repository; validation commands run in the copy, never the original.",
    )
    .argument("[path]", "repository path", ".")
    .option("--run-checks", "permit validation commands inside the disposable copy", false)
    .option("--format <format>", "output format: text, brief, or json", "text")
    .option(
      "--fail-on <severity>",
      "failure threshold: info, low, medium, high, critical, or none",
      "high",
    )
    .option("--receipt <path>", "write a portable coverage receipt (marked as shadow)")
    .option("--receipt-key <path>", "sign the receipt with an Ed25519 private key (PEM)")
    .action(async (path: string, options: ShadowCommandOptions) => {
      try {
        if (!SHADOW_FORMATS.has(options.format as ShadowFormat)) {
          throw new Error(`Invalid shadow output format "${options.format}".`);
        }
        const failOn = parseThreshold(options.failOn);
        const privateKeyPem = options.receiptKey === undefined
          ? undefined
          : await readFile(options.receiptKey, "utf8");
        const outcome = await runShadow({
          root: path,
          runChecks: options.runChecks,
          failOn,
          format: options.format as ShadowFormat,
          ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
          ...(privateKeyPem === undefined ? {} : { receiptKeyPem: privateKeyPem }),
        });
        process.stdout.write(outcome.output);
        process.exitCode = outcome.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
