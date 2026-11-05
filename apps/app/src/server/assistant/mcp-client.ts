// The assistant as an MCP client of our own /mcp (ADR 0030, ADR 0200). It builds the same MCP
// server /mcp builds for every request (createCrmMcpServer: curated tools, describe_operations,
// call_operation, server instructions) for a caller acting as actor `assistant`, and talks to it
// over an in-process MCP transport. So the assistant sees exactly the tools, descriptions and
// results an external MCP client sees, and every call goes through the same pipeline: gate,
// change sets, simulation, audit. Only the transport differs: no HTTP hop and no OAuth token,
// because the conversation object already acts for its signed-in owner.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AssistantTool } from "@relationship-os/core";
import { createCrmMcpServer, type McpCaller } from "../mcp/tools.ts";

export interface AssistantMcp {
  tools: AssistantTool[];
  instructions: string | undefined;
  close(): Promise<void>;
}

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** Connects an MCP client to a fresh CRM MCP server for `caller` and lists its tools. */
export async function connectAssistantMcp(caller: McpCaller): Promise<AssistantMcp> {
  const server = createCrmMcpServer(caller, APP_VERSION);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "relationship-os-assistant", version: APP_VERSION });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return {
    instructions: client.getInstructions(),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      async call(args) {
        const result = await client.callTool({ name: tool.name, arguments: args });
        return {
          text: textOf(result),
          isError: Boolean((result as { isError?: boolean }).isError),
        };
      },
    })),
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}
