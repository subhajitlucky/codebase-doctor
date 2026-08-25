import { Command } from "commander";
import { startMcpStdioServer } from "../mcp/server.js";

export function createMcpCommand(): Command {
  return new Command("mcp")
    .description(
      "Serve read-only audits over the Model Context Protocol on stdio.",
    )
    .action(async () => {
      try {
        await startMcpStdioServer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`codebase-doctor: ${message}\n`);
        process.exitCode = 2;
      }
    });
}