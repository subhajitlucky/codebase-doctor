#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { VERSION } from "./index.js";

export function createProgram(): Command {
  return new Command()
    .name("codebase-doctor")
    .description("Evidence-backed diagnostics for software repositories.")
    .version(VERSION);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await createProgram().parseAsync();
}
