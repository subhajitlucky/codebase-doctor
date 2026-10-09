#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createAuditCommand } from "./commands/audit.js";
import { createBisectCommand } from "./commands/bisect.js";
import { createDemoCommand } from "./commands/demo.js";
import { createInstructionsCommand } from "./commands/instructions.js";
import { createIntentCommand } from "./commands/intent.js";
import { createMcpCommand } from "./commands/mcp.js";
import { createPheromoneCommand } from "./commands/pheromone.js";
import { createReviewCommand } from "./commands/review.js";
import { createScanCommand } from "./commands/scan.js";
import { createShadowCommand } from "./commands/shadow.js";
import { createSwarmCommand } from "./commands/swarm.js";
import { createVerifyCommand } from "./commands/verify.js";
import { createVerifyReceiptCommand } from "./commands/verify-receipt.js";
import { VERSION } from "./version.js";

export function createProgram(): Command {
  const program = new Command()
    .name("codebase-doctor")
    .description("Evidence-backed diagnostics for software repositories.")
    .version(VERSION);
  program.addCommand(createScanCommand());
  program.addCommand(createAuditCommand());
  program.addCommand(createDemoCommand());
  program.addCommand(createShadowCommand());
  program.addCommand(createSwarmCommand());
  program.addCommand(createPheromoneCommand());
  program.addCommand(createIntentCommand());
  program.addCommand(createBisectCommand());
  program.addCommand(createReviewCommand());
  program.addCommand(createVerifyCommand());
  program.addCommand(createVerifyReceiptCommand());
  program.addCommand(createInstructionsCommand());
  program.addCommand(createMcpCommand());
  return program;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const program = createProgram();
  // With no arguments, show the same help a user gets from --help and treat
  // the invocation as intentional rather than an error.
  if (process.argv.length <= 2) {
    program.outputHelp();
  } else {
    await program.parseAsync();
  }
}
