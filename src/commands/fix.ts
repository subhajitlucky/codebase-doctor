import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { auditCodebase } from "../core/scan.js";
import { planImportRepair } from "../repair/repair.js";
import { buildRepairReceipt, renderRepairText, verifyImportRepair } from "../repair/verify.js";
import { VERSION } from "../version.js";

interface FixCommandOptions {
  patch?: string;
  receipt?: string;
  json: boolean;
}

export function createFixCommand(): Command {
  return new Command("fix")
    .description(
      "Generate a repair for a finding and verify it in a disposable copy before writing it.",
    )
    .argument("<fingerprint>", "fingerprint of the finding to repair")
    .argument("[path]", "repository path", ".")
    .option("--patch <path>", "write the verified patch to this path")
    .option("--receipt <path>", "write the repair receipt (patch hash + before/after verification)")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (fingerprint: string, path: string, options: FixCommandOptions) => {
      try {
        if (options.patch === undefined) {
          throw new Error("--patch is required so the verified patch has a destination.");
        }
        const original = await auditCodebase({
          root: path,
          runChecks: false,
          format: "text",
          timeoutMs: 120_000,
          failOn: "none",
          includeDatabaseAudit: true,
          includeSecurityAudit: true,
        });
        const finding = original.findings.find((entry) => entry.fingerprint === fingerprint);
        if (finding === undefined) {
          throw new Error(
            `No finding with fingerprint ${fingerprint} in ${path}. Run \`codebase-doctor audit . --json\` to list fingerprints.`,
          );
        }

        const plan = await planImportRepair(path, finding);
        if (plan === undefined) {
          throw new Error(
            `No unambiguous repair template applies to ${finding.ruleId} at ${
              finding.location?.path ?? "(repository)"
            }. Repairs never guess.`,
          );
        }

        const outcome = await verifyImportRepair(path, plan, original);
        const receipt = buildRepairReceipt(plan, outcome, path, VERSION);

        if (outcome.verification.status === "failed") {
          process.stderr.write(
            `codebase-doctor: repair verification failed for ${plan.file}:\n`,
          );
          for (const reason of outcome.verification.reasons) {
            process.stderr.write(`codebase-doctor: - ${reason}\n`);
          }
          process.stderr.write("codebase-doctor: no patch was written; nothing was applied.\n");
          process.exitCode = 1;
          return;
        }

        await writeFile(options.patch, outcome.patchText, "utf8");
        process.stderr.write(`codebase-doctor: verified patch written to ${options.patch}\n`);
        if (options.receipt !== undefined) {
          await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          process.stderr.write(`codebase-doctor: repair receipt written to ${options.receipt}\n`);
        }
        process.stdout.write(
          options.json ? `${JSON.stringify(receipt, null, 2)}\n` : renderRepairText(receipt),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
