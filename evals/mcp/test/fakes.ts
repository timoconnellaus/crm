// Test doubles: a scripted model and an in-memory MCP session.
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "../lib/agent.ts";
import type { McpSession, ToolCallResult, ToolInfo } from "../lib/mcp.ts";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

let ids = 0;

export function toolUse(name: string, input: Record<string, unknown>): Block {
  ids += 1;
  return { type: "tool_use", id: `toolu_${ids}`, name, input };
}

export function text(value: string): Block {
  return { type: "text", text: value };
}

export function message(content: Block[], stopReason?: Anthropic.StopReason): Anthropic.Message {
  const stop = stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  // Only the fields the loop reads are filled in; the rest of Message does not matter here.
  return {
    id: `msg_${ids}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

/** A model that replays `script` in order and records every request. */
export function scriptedModel(script: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const model: ModelClient = {
    async createMessage(params) {
      // Snapshot: the loop keeps appending to the same array.
      requests.push({ ...params, messages: [...params.messages] });
      const next = script.shift();
      if (!next) throw new Error("the script ran out");
      return next;
    },
  };
  return { model, requests };
}

export type Handler = (args: Record<string, unknown>) => unknown;

/** An MCP session whose tools are `handlers`; a handler result {isError: true, …} is an error. */
export function fakeSession(
  handlers: Record<string, Handler>,
  instructions = "Server instructions",
): McpSession & { calls: { name: string; args: Record<string, unknown> }[]; closed: boolean } {
  const session = {
    instructions,
    calls: [] as { name: string; args: Record<string, unknown> }[],
    closed: false,
    async listTools(): Promise<ToolInfo[]> {
      return Object.keys(handlers).map((name) => ({
        name,
        description: `The ${name} tool`,
        inputSchema: { type: "object", properties: {} },
      }));
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
      session.calls.push({ name, args });
      const handler = handlers[name];
      if (!handler)
        return { isError: true, text: JSON.stringify({ error: { code: "unknown_tool" } }) };
      const result = handler(args);
      const isError = Boolean((result as { isError?: boolean } | null)?.isError);
      return { isError, text: JSON.stringify(result) };
    },
    async close() {
      session.closed = true;
    },
  };
  return session;
}
