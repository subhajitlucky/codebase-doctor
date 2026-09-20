import { Command } from "commander";
import {
  instructionSnippets,
  parseInstructionTargets,
  renderInstructionJson,
  renderInstructionText
} from "../instructions/snippets.js";

interface InstructionsCommandOptions {
  target?: string;
  json: boolean;
}

export function createInstructionsCommand(): Command {
  return new Command("instructions")
    .description(
      "Print ready-to-paste agent instruction snippets for this repository.",
    )
    .option(
      "--target <targets>",
      "comma-separated targets: agents, claude, cursor, windsurf, cline, copilot, mcp, or all",
      "all",
    )
    .option("--json", "emit structured JSON instead of text", false)
    .action((options: InstructionsCommandOptions) => {
      try {
        const targets = parseInstructionTargets(options.target);
        const snippets = instructionSnippets(targets);
        process.stdout.write(
          options.json ? renderInstructionJson(snippets) : renderInstructionText(snippets),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
