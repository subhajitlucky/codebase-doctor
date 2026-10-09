import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { verifyReceipt } from "../receipts/receipt.js";

export function createVerifyReceiptCommand(): Command {
  return new Command("verify-receipt")
    .description("Verify a coverage receipt: digest integrity, optional signature, and coverage summary.")
    .argument("<file>", "path to a receipt JSON file")
    .action(async (file: string) => {
      try {
        const text = await readFile(file, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          process.stderr.write(`codebase-doctor: ${file} is not valid JSON\n`);
          process.exitCode = 2;
          return;
        }
        const verification = verifyReceipt(parsed);
        if (!verification.valid) {
          for (const reason of verification.reasons) {
            process.stderr.write(`codebase-doctor: receipt invalid: ${reason}\n`);
          }
          process.exitCode = 2;
          return;
        }
        process.stdout.write(verification.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
