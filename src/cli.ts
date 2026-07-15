#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createAuditCommand } from "./commands/audit.js";
import { createScanCommand } from "./commands/scan.js";
import { VERSION } from "./version.js";

export function createProgram(): Command {
  const program = new Command()
    .name("codebase-doctor")
    .description("Evidence-backed diagnostics for software repositories.")
    .version(VERSION);
  program.addCommand(createScanCommand());
  program.addCommand(createAuditCommand());
  return program;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  await createProgram().parseAsync();
}
