import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.js";
import { TOOL_DEFINITIONS } from "./tool-schemas.js";
import { errorToolResult, handleToolCall } from "./tools.js";

export const MCP_SERVER_NAME = "codebase-doctor";

const SERVER_INSTRUCTIONS = [
  "Codebase Doctor audits repositories and returns deterministic,",
  "evidence-backed findings for coding agents.",
  "Models build; Codebase Doctor verifies: it never edits files, runs",
  "repository checks, or touches a database through this server.",
].join(" ");

export function createMcpServer(): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...TOOL_DEFINITIONS],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(request.params.name, request.params.arguments);
    } catch (error) {
      return errorToolResult(error);
    }
  });
  return server;
}

/** Serve the MCP stdio transport until the client closes the connection. */
export async function startMcpStdioServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}