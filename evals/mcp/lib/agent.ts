// The agentic tool-use loop: the model (behind ModelClient, an OpenAI-compatible chat-completions
// client) proposes tool calls, the MCP session (behind ToolExecutor) runs them, and every call is
// recorded for grading. The conversation is append-only: each assistant message goes back exactly
// as it came (reasoning fields included), followed by one `tool` message per tool call.
import { parseResult, type ToolCallResult } from "./mcp.ts";
import {
  type ChatMessage,
  type ChatTool,
  type ModelClient,
  type ModelParams,
  samplingFields,
} from "./model.ts";

export type { ModelClient } from "./model.ts";

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
  /** The assistant's text after each prompt (joined text of that prompt's turns). */
  replies: string[];
  /** The reply to the last prompt. */
  finalText: string;
  /** The last finish_reason. */
  stopReason: string | null;
  /** Model requests made. */
  turns: number;
  /** Set when the loop stopped for a reason other than a normal end of turn. */
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface RunAgentOptions extends ModelParams {
  model: ModelClient;
  executor: ToolExecutor;
  modelId: string;
  system: string;
  tools: ChatTool[];
  prompts: string[];
  /** Model requests allowed across all prompts. */
  maxTurns: number;
}

export const emptyRun = (): AgentRun => ({
  calls: [],
  replies: [],
  finalText: "",
  stopReason: null,
  turns: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
});

/** Parses a tool call's JSON arguments; an error message when they are not a JSON object. */
export function parseArguments(
  raw: string,
): { input: Record<string, unknown> } | { error: string } {
  if (!raw.trim()) return { input: {} };
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { input: value as Record<string, unknown> };
    }
    return { error: "the tool arguments must be a JSON object" };
  } catch (error) {
    return { error: `the tool arguments are not valid JSON (${(error as Error).message})` };
  }
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRun> {
  const messages: ChatMessage[] = options.system
    ? [{ role: "system", content: options.system }]
    : [];
  const run = emptyRun();

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
      const response = await options.model.createCompletion({
        model: options.modelId,
        messages,
        ...(options.tools.length ? { tools: options.tools } : {}),
        max_tokens: options.maxTokens ?? 16000,
        ...samplingFields(options),
      });
      run.usage.inputTokens += response.usage?.prompt_tokens ?? 0;
      run.usage.outputTokens += response.usage?.completion_tokens ?? 0;
      const choice = response.choices[0];
      if (!choice) throw new Error("The model returned no choices");
      run.stopReason = choice.finish_reason;
      const message = choice.message;
      messages.push({ ...message, role: "assistant", content: message.content ?? null });
      const text = (message.content ?? "").trim();
      if (text) texts.push(text);

      const toolCalls = message.tool_calls ?? [];
      // Some servers end a tool-calling turn with finish_reason "stop": the calls decide.
      if (toolCalls.length === 0) {
        if (choice.finish_reason !== "stop" && choice.finish_reason !== null) {
          run.error = `The model stopped with ${choice.finish_reason}`;
        }
        done = true;
        break;
      }

      for (const call of toolCalls) {
        const name = call.function.name;
        const parsed = parseArguments(call.function.arguments ?? "");
        let outcome: ToolCallResult;
        let input: Record<string, unknown> = {};
        if ("error" in parsed) {
          outcome = { isError: true, text: JSON.stringify({ error: { message: parsed.error } }) };
        } else {
          input = parsed.input;
          try {
            outcome = await options.executor.callTool(name, input);
          } catch (error) {
            outcome = {
              isError: true,
              text: JSON.stringify({
                error: { message: (error as Error).message ?? String(error) },
              }),
            };
          }
        }
        run.calls.push({
          promptIndex,
          turn: run.turns,
          name,
          input,
          isError: outcome.isError,
          resultText: outcome.text,
          result: parseResult(outcome.text),
        });
        // The chat format has no error flag on a tool message; the JSON error body says it.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.text || "(no content)",
        });
      }
    }
    run.replies.push(texts.join("\n\n"));
    if (!done) break;
  }
  run.finalText = run.replies.at(-1) ?? "";
  return run;
}
