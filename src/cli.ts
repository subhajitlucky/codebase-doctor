#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createAuditCommand } from "./commands/audit.js";
import { createInstructionsCommand } from "./commands/instructions.js";
import { createMcpCommand } from "./commands/mcp.js";
import { createScanCommand } from "./commands/scan.js";
import { createVerifyCommand } from "./commands/verify.js";
import { VERSION } from "./version.js";

export function createProgram(): Command {
  const program = new Command()
    .name("codebase-doctor")
    .description("Evidence-backed diagnostics for software repositories.")
    .version(VERSION);
  program.addCommand(createScanCommand());
  program.addCommand(createAuditCommand());
  program.addCommand(createVerifyCommand());
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
