import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { mergePheromones, renderIndexText } from "../pheromones/pheromone.js";

interface MergeCommandOptions {
  out?: string;
  minSignals: string;
  allowInvalid: boolean;
  json: boolean;
}

function parseMinSignals(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid min-signals "${value}": expected a positive integer.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Invalid min-signals "${value}": expected a positive integer.`);
  }
  return count;
}

export function createPheromoneCommand(): Command {
  const pheromone = new Command("pheromone").description(
    "Merge privacy-bounded pattern signals into a public index (pheromone immune system).",
  );

  pheromone
    .command("merge")
    .description(
      "Verify signals and merge them into a pattern index; patterns below the k-anonymity threshold are excluded.",
    )
    .argument("<files...>", "pheromone signal JSON files to merge")
    .option("--out <path>", "write the index JSON to this path")
    .option("--min-signals <n>", "k-anonymity: exclude patterns seen in fewer than n signals (default 1)", "1")
    .option("--allow-invalid", "skip invalid signals instead of failing closed", false)
    .option("--json", "print the index as JSON", false)
    .action(async (files: string[], options: MergeCommandOptions) => {
      try {
        if (files.length === 0) {
          throw new Error("pheromone merge requires at least one signal file.");
        }
        const values: unknown[] = [];
        for (const file of files) {
          const text = await readFile(file, "utf8");
          try {
            values.push(JSON.parse(text));
          } catch {
            values.push(null);
          }
        }
        const merged = mergePheromones(values, {
          minSignals: parseMinSignals(options.minSignals),
          allowInvalid: options.allowInvalid,
        });

        if (merged.index === undefined) {
          for (const rejection of merged.rejected) {
            for (const reason of rejection.reasons) {
              process.stderr.write(
                `codebase-doctor: signal ${rejection.index + 1} rejected: ${reason}\n`,
              );
            }
          }
          process.stderr.write(
            "codebase-doctor: refusing to build an index from invalid signals (use --allow-invalid to skip them).\n",
          );
          process.exitCode = 2;
          return;
        }

        if (merged.rejected.length > 0) {
          for (const rejection of merged.rejected) {
            process.stderr.write(
              `codebase-doctor: signal ${rejection.index + 1} skipped: ${rejection.reasons.join("; ")}\n`,
            );
          }
        }

        if (options.out !== undefined) {
          await writeFile(options.out, `${JSON.stringify(merged.index, null, 2)}\n`, "utf8");
          process.stderr.write(`codebase-doctor: index written to ${options.out}\n`);
        }
        process.stdout.write(
          options.json
            ? `${JSON.stringify(merged.index, null, 2)}\n`
            : renderIndexText(merged.index),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });

  return pheromone;
}
