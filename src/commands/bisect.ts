import { Command } from "commander";
import { runBisect } from "../bisect/runner.js";

interface BisectCommandOptions {
  maxCommits: string;
  allHistory: boolean;
  json: boolean;
}

function parseMaxCommits(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid max commits "${value}": expected a positive integer.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Invalid max commits "${value}": expected a positive integer.`);
  }
  return count;
}

export function createBisectCommand(): Command {
  return new Command("bisect")
    .description(
      "Find the commit where a rule or fingerprint first appeared, with parent-absence evidence.",
    )
    .argument("<target>", "rule id (security/secrets/provider-token) or finding fingerprint")
    .argument("[path]", "repository path", ".")
    .option("--max-commits <n>", "maximum commits to scan from the root", "200")
    .option("--all-history", "scan every commit including merges (default: first-parent)", false)
    .option("--json", "emit machine-readable JSON", false)
    .action(async (target: string, path: string, options: BisectCommandOptions) => {
      try {
        const outcome = await runBisect({
          root: path,
          target,
          maxCommits: parseMaxCommits(options.maxCommits),
          firstParent: !options.allHistory,
        });
        process.stdout.write(
          options.json
            ? `${JSON.stringify(outcome.result, null, 2)}\n`
            : outcome.output,
        );
        process.exitCode = outcome.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
