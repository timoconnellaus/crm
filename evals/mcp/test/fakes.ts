// Test doubles: a scripted chat-completions model and an in-memory MCP session.

import type { McpSession, ToolCallResult, ToolInfo } from "../lib/mcp.ts";
import type {
  AssistantMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatToolCall,
  ModelClient,
} from "../lib/model.ts";

let ids = 0;

/** A tool call as the model sends it: arguments are a JSON string. */
export function toolCall(name: string, input: Record<string, unknown>): ChatToolCall {
  ids += 1;
  return {
    id: `call_${ids}`,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

/** An assistant reply: optional text and tool calls. finish_reason follows from the calls. */
export function reply(
  content: string | null,
  calls: ChatToolCall[] = [],
  finishReason?: string,
): ChatCompletionResponse {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
  return {
    id: `chatcmpl_${ids}`,
    choices: [
      { index: 0, message, finish_reason: finishReason ?? (calls.length ? "tool_calls" : "stop") },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

/** A model that replays `script` in order and records every request. */
export function scriptedModel(script: ChatCompletionResponse[]) {
  const requests: ChatCompletionRequest[] = [];
  const model: ModelClient = {
    async createCompletion(request) {
      // Snapshot: the loop keeps appending to the same array.
      requests.push({ ...request, messages: [...request.messages] });
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
