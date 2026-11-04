// A small interface over the MCP client, so the agent loop and the tasks can be unit-tested with
// a fake, and the real implementation over Streamable HTTP with a Bearer token.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface ToolCallResult {
  isError: boolean;
  /** The tool's text content (the CRM server returns one JSON text block). */
  text: string;
}

export interface McpSession {
  /** The server's instructions from initialize, used as the model's system prompt. */
  readonly instructions: string | undefined;
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export async function openMcpSession(
  baseUrl: string,
  accessToken: string,
  clientName = "crm-mcp-eval",
): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(transport);
  return {
    instructions: client.getInstructions(),
    async listTools() {
      const { tools } = await client.listTools();
      return tools as ToolInfo[];
    },
    async callTool(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
      const text = (result.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      return { isError: Boolean(result.isError), text };
    },
    close: () => client.close(),
  };
}

/** Parses a tool's JSON text result; null when it is not JSON. */
export function parseResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when a tool result says the write was queued for approval instead of applied. */
export function isPending(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "pending_approval"
  );
}
