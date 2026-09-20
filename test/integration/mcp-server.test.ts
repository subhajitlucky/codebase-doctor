import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const cliPath = resolve(repositoryRoot, "src", "cli.ts");
const fixtureNodePass = resolve(repositoryRoot, "test", "fixtures", "node-pass");

const openServers: StdioClientTransport[] = [];

function isolatedServerEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("GIT_CONFIG_")) continue;
    environment[name] = value;
  }
  environment.DATABASE_URL = "";
  environment.SUPABASE_DB_URL = "";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = join(repositoryRoot, ".codebase-doctor-empty-global-config");
  return environment;
}

async function connectTestClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", cliPath, "mcp"],
    cwd: repositoryRoot,
    env: isolatedServerEnvironment(),
  });
  openServers.push(transport);
  const client = new Client({ name: "codebase-doctor-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function firstText(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    throw new Error("MCP result was not an object.");
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error("MCP result had no content array.");
  }
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text;
    }
  }
  throw new Error("MCP result had no text content.");
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()?.close();
});

describe("codebase-doctor mcp server lifecycle", () => {
  it(
    "completes the initialize handshake and reports its identity",
    { timeout: 60_000 },
    async () => {
      const client = await connectTestClient();

      expect(client.getServerVersion()).toMatchObject({
        name: "codebase-doctor",
      });
    },
  );

  it(
    "lists every read-only tool over stdio",
    { timeout: 60_000 },
    async () => {
      const client = await connectTestClient();
      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "audit_codebase",
        "describe_capabilities",
        "verify_changes",
        "explain_finding",
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type).toBe("object");
      }
    },
  );

  it(
    "answers describe_capabilities and a real audit_codebase call",
    { timeout: 120_000 },
    async () => {
      const client = await connectTestClient();
      const capabilities = await client.callTool({
        name: "describe_capabilities",
        arguments: {},
      });
      const capabilityReport = JSON.parse(firstText(capabilities)) as {
        server: { name: string; version: string };
      };
      expect(capabilityReport.server.name).toBe("codebase-doctor");

      const audit = await client.callTool({
        name: "audit_codebase",
        arguments: { path: fixtureNodePass },
      });
      expect(audit.isError).not.toBe(true);
      const report = JSON.parse(firstText(audit)) as {
        schemaVersion: string;
        findings: unknown[];
      };
      expect(report.schemaVersion).toBe("1");
      expect(Array.isArray(report.findings)).toBe(true);
    },
  );

  it(
    "maps invalid arguments to an actionable tool error",
    { timeout: 60_000 },
    async () => {
      const client = await connectTestClient();
      const failed = await client.callTool({
        name: "audit_codebase",
        arguments: { base: "main" },
      });

      expect(failed.isError).toBe(true);
      expect(firstText(failed)).toMatch(
        /codebase-doctor: .*--base option requires --changed/u,
      );
    },
  );
});