import { Command } from "commander";
import { runDemo } from "../demo/runner.js";

export function createDemoCommand(): Command {
  return new Command("demo")
    .description(
      "Audit a disposable broken fixture: tracked secret, broken import, and blast radius. " +
      "No configuration needed.",
    )
    .action(async () => {
      try {
        const outcome = await runDemo();
        process.stdout.write(outcome.output);
        process.exitCode = outcome.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
