import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { auditCodebase } from "../core/scan.js";
import { VERSION } from "../version.js";
import { renderWitnessText, synthesizeWitness } from "../witness/witness.js";

interface WitnessCommandOptions {
  out?: string;
  json: boolean;
}

export function createWitnessCommand(): Command {
  return new Command("witness")
    .description(
      "Synthesize the concrete exploit for an injection-class finding: payload, transformed sink text, and why it violates the boundary.",
    )
    .argument("<fingerprint>", "fingerprint of the finding to synthesize a witness for")
    .argument("[path]", "repository path", ".")
    .option("--out <path>", "write the witness artifact (canonical JSON with digest)")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (fingerprint: string, path: string, options: WitnessCommandOptions) => {
      try {
        const result = await auditCodebase({
          root: path,
          runChecks: false,
          format: "text",
          timeoutMs: 120_000,
          failOn: "none",
          includeDatabaseAudit: true,
          includeSecurityAudit: true,
        });
        const finding = result.findings.find((entry) => entry.fingerprint === fingerprint);
        if (finding === undefined) {
          throw new Error(
            `No finding with fingerprint ${fingerprint} in ${path}. Run \`codebase-doctor audit . --json\` to list fingerprints.`,
          );
        }

        const outcome = await synthesizeWitness(path, finding, { toolVersion: VERSION });
        if (outcome.status === "undecided") {
          process.stderr.write(
            `codebase-doctor: no witness synthesized: ${outcome.reason}\n`,
          );
          process.stderr.write(
            "codebase-doctor: undecidable shapes are reported, never guessed.\n",
          );
          process.exitCode = 1;
          return;
        }

        if (options.out !== undefined) {
          await writeFile(options.out, `${JSON.stringify(outcome.artifact, null, 2)}\n`, "utf8");
          process.stderr.write(`codebase-doctor: witness artifact written to ${options.out}\n`);
        }
        process.stdout.write(
          options.json
            ? `${JSON.stringify(outcome.artifact, null, 2)}\n`
            : renderWitnessText(outcome.artifact),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
