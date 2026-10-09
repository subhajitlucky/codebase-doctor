import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { parseJournal, parsePolicy, type EconomicPolicy } from "../economy/ledger.js";
import { buildEconomyReport, evaluateEconomy, renderEconomyText } from "../economy/verify.js";
import { VERSION } from "../version.js";

const DEFAULT_POLICY: EconomicPolicy = {
  policyVersion: "1",
  invariants: [
    { id: "no-overdraft", kind: "non-negative-balances" },
    { id: "declared-balances", kind: "declared-balances" },
  ],
};

interface EconomyVerifyOptions {
  policy?: string;
  out?: string;
  json: boolean;
  requireProved: boolean;
}

export function createEconomyCommand(): Command {
  const economy = new Command("economy").description(
    "Replay a transaction journal in a disposable shadow ledger and decide economic invariants.",
  );

  economy
    .command("verify")
    .description(
      "Prove or witness overdrafts, double-spends, limits, allowlist breaches, and declared-balance mismatches.",
    )
    .argument("<journal>", "transaction journal JSON")
    .option("--policy <path>", "economic policy JSON; defaults to no-overdraft + declared-balances")
    .option("--out <path>", "write the economic report artifact (canonical JSON with digest)")
    .option("--require-proved", "exit 2 when any invariant is undecided", false)
    .option("--json", "emit machine-readable JSON", false)
    .action(async (journalPath: string, options: EconomyVerifyOptions) => {
      try {
        const journal = parseJournal(await readFile(journalPath, "utf8"), journalPath);
        const policy = options.policy === undefined
          ? DEFAULT_POLICY
          : parsePolicy(await readFile(options.policy, "utf8"), options.policy);
        const claims = evaluateEconomy(journal, policy);
        const report = buildEconomyReport(
          claims,
          journal,
          { journal: journalPath, policy: options.policy ?? null },
          VERSION,
        );

        if (options.out !== undefined) {
          await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
          process.stderr.write(`codebase-doctor: economic report written to ${options.out}\n`);
        }
        process.stdout.write(
          options.json ? `${JSON.stringify(report, null, 2)}\n` : renderEconomyText(report),
        );

        if (report.summary.violated > 0) {
          process.exitCode = 1;
        } else if (options.requireProved && report.summary.undecided > 0) {
          process.exitCode = 2;
          process.stderr.write(
            "codebase-doctor: --require-proved rejected undecided invariants.\n",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });

  return economy;
}
