import { Command } from "commander";
import { runSwarm } from "../swarm/runner.js";
import { parseThreshold } from "./scan.js";

interface SwarmCommandOptions {
  workers: string;
  failOn: string;
  json: boolean;
  requireComplete: boolean;
  receiptDir?: string;
}

function parseWorkers(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid workers "${value}": expected a positive integer.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Invalid workers "${value}": expected a positive integer.`);
  }
  return count;
}

export function createSwarmCommand(): Command {
  return new Command("swarm")
    .description(
      "Verify multiple repositories with parallel read-only workers and compose a fleet verdict.",
    )
    .argument("<paths...>", "repository paths to verify")
    .option("--workers <n>", "maximum parallel verifier workers (1-16)", "4")
    .option(
      "--fail-on <severity>",
      "failure threshold per repository: info, low, medium, high, critical, or none",
      "high",
    )
    .option("--require-complete", "exit 2 when any repository has unknown or gap coverage", false)
    .option("--receipt-dir <path>", "write one coverage receipt per repository into this directory")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (paths: string[], options: SwarmCommandOptions) => {
      try {
        if (paths.length === 0) {
          throw new Error("swarm requires at least one repository path.");
        }
        const outcome = await runSwarm({
          roots: paths,
          workers: parseWorkers(options.workers),
          failOn: parseThreshold(options.failOn),
          requireComplete: options.requireComplete,
          ...(options.receiptDir === undefined ? {} : { receiptDir: options.receiptDir }),
          json: options.json,
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
