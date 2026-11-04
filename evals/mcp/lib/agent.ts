// The agentic tool-use loop: Claude (behind ModelClient) proposes tool calls, the MCP session
// (behind ToolExecutor) runs them, and every call is recorded for grading. The conversation is
// append-only: each assistant turn goes back exactly as it came, thinking blocks included.
import type Anthropic from "@anthropic-ai/sdk";
import { parseResult, type ToolCallResult } from "./mcp.ts";

export interface ModelClient {
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface ToolExecutor {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface RecordedCall {
  /** Index of the user prompt this call answered (multi-turn tasks have several). */
  promptIndex: number;
  /** Model request number within the task, from 1. */
  turn: number;
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  resultText: string;
  /** The parsed JSON result, or null. */
  result: unknown;
}

export interface AgentRun {
  calls: RecordedCall[];
  /** The assistant's text after each prompt (joined text blocks of that prompt's turns). */
  replies: string[];
  /** The reply to the last prompt. */
  finalText: string;
  stopReason: string | null;
  /** Model requests made. */
  turns: number;
  /** Set when the loop stopped for a reason other than end_turn. */
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface RunAgentOptions {
  model: ModelClient;
  executor: ToolExecutor;
  modelId: string;
  system: string;
  tools: Anthropic.Tool[];
  prompts: string[];
  /** Model requests allowed across all prompts. */
  maxTurns: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRun> {
  const messages: Anthropic.MessageParam[] = [];
  const run: AgentRun = {
    calls: [],
    replies: [],
    finalText: "",
    stopReason: null,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  for (const [promptIndex, prompt] of options.prompts.entries()) {
    messages.push({ role: "user", content: prompt });
    const texts: string[] = [];
    let done = false;
    while (!done) {
      if (run.turns >= options.maxTurns) {
        run.error = `Stopped after ${options.maxTurns} model turns without finishing`;
        break;
      }
      run.turns += 1;
      const response = await options.model.createMessage({
        model: options.modelId,
        max_tokens: options.maxTokens ?? 16000,
        system: options.system,
        tools: options.tools,
        messages,
        ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      });
      run.usage.inputTokens += response.usage?.input_tokens ?? 0;
      run.usage.outputTokens += response.usage?.output_tokens ?? 0;
      run.stopReason = response.stop_reason;
      messages.push({ role: "assistant", content: response.content });
      const text = textOf(response.content);
      if (text) texts.push(text);

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") {
        if (response.stop_reason !== "end_turn" && response.stop_reason !== "stop_sequence") {
          run.error = `The model stopped with ${response.stop_reason}`;
        }
        done = true;
        break;
      }

      const uses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      // Every tool_result for one assistant turn goes back in a single user message.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        let outcome: ToolCallResult;
        try {
          outcome = await options.executor.callTool(use.name, input);
        } catch (error) {
          outcome = {
            isError: true,
            text: JSON.stringify({ error: { message: (error as Error).message ?? String(error) } }),
          };
        }
        run.calls.push({
          promptIndex,
          turn: run.turns,
          name: use.name,
          input,
          isError: outcome.isError,
          resultText: outcome.text,
          result: parseResult(outcome.text),
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.text || "(no content)",
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
    }
    run.replies.push(texts.join("\n\n"));
    if (!done) break;
  }
  run.finalText = run.replies.at(-1) ?? "";
  return run;
}
