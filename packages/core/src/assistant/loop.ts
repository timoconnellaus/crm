// One turn of the in-app assistant (ADR 0200): the `assistant` role's model with the CRM's MCP
// tools, run with the AI SDK until it answers in text or runs out of steps, streaming events as it
// goes. The conversation object (apps/app) owns storage, resumable streaming and the MCP client;
// this is the loop itself, kept here so it is tested in workerd with fake models.
import {
  dynamicTool,
  jsonSchema,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import type { ChatModel } from "../ai/client.ts";
import { type AssistantEventInput, parseToolOutput, pendingOf } from "./events.ts";

/** A tool the assistant may call: one MCP tool of our own /mcp. */
export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface AssistantTurnInput {
  /** The role's models, primary first (ModelRunner.chatModels("assistant")). */
  models: readonly ChatModel[];
  instructions: string;
  /** Earlier turns, as messagesForModel returns them. */
  history: readonly ModelMessage[];
  userText: string;
  tools: readonly AssistantTool[];
  emit: (event: AssistantEventInput) => void;
  /** Model steps per turn (each step may call tools). */
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface AssistantTurnResult {
  /** The turn's new messages: the user message, then the model's and tools' messages. */
  messages: ModelMessage[];
  status: "done" | "error" | "stopped";
  model?: string;
  fellBack?: boolean;
  error?: string;
  /** The final text of the turn (for the conversation list's preview). */
  text: string;
}

export const ASSISTANT_MAX_STEPS = 16;
/** A tool result longer than this is cut before the model sees it. */
export const TOOL_RESULT_MAX_CHARS = 24_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The model call failed";
}

function toolSet(input: AssistantTurnInput, attempt: { emitted: boolean }): ToolSet {
  const tools: ToolSet = {};
  for (const t of input.tools) {
    tools[t.name] = dynamicTool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args, options) => {
        const callArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        attempt.emitted = true;
        input.emit({ type: "tool-call", id: options.toolCallId, tool: t.name, input: callArgs });
        let result: { text: string; isError: boolean };
        try {
          result = await t.call(callArgs);
        } catch (error) {
          result = {
            text: JSON.stringify({ error: { message: errorMessage(error) } }),
            isError: true,
          };
        }
        const output = parseToolOutput(result.text);
        const pending = result.isError ? undefined : pendingOf(output);
        input.emit({
          type: "tool-result",
          id: options.toolCallId,
          tool: t.name,
          output,
          isError: result.isError,
          ...(pending ? { pending } : {}),
        });
        const text =
          result.text.length > TOOL_RESULT_MAX_CHARS
            ? `${result.text.slice(0, TOOL_RESULT_MAX_CHARS)}… (cut: ${result.text.length} characters; ask for less)`
            : result.text;
        return result.isError ? `ERROR: ${text}` : text;
      },
    });
  }
  return tools;
}

async function attemptTurn(
  input: AssistantTurnInput,
  model: ChatModel,
  messages: ModelMessage[],
  attempt: { emitted: boolean },
): Promise<{ messages: ModelMessage[]; text: string; stopped: boolean }> {
  let streamError: unknown = null;
  let thinking = false;
  let text = "";
  const result = streamText({
    model: model.model,
    instructions: input.instructions,
    messages,
    tools: toolSet(input, attempt),
    stopWhen: stepCountIs(input.maxSteps ?? ASSISTANT_MAX_STEPS),
    maxOutputTokens: model.params.maxTokens,
    temperature: model.params.temperature,
    maxRetries: 1,
    ...(model.providerOptions ? { providerOptions: model.providerOptions } : {}),
    ...(model.headers ? { headers: model.headers } : {}),
    ...(input.signal ? { abortSignal: input.signal } : {}),
    onError: ({ error }) => {
      streamError = error;
    },
  });
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        if (!part.text) break;
        attempt.emitted = true;
        thinking = false;
        text += part.text;
        input.emit({ type: "text", delta: part.text });
        break;
      case "reasoning-delta":
        if (!thinking) {
          thinking = true;
          input.emit({ type: "thinking" });
        }
        break;
      case "finish-step":
        // A new step starts a new paragraph of text.
        if (text && !text.endsWith("\n")) text += "\n\n";
        thinking = false;
        break;
      case "error":
        streamError = part.error;
        break;
      default:
        break;
    }
  }
  if (streamError) throw streamError;
  const responseMessages = await result.responseMessages;
  return {
    messages: responseMessages as ModelMessage[],
    text: text.trim(),
    stopped: input.signal?.aborted ?? false,
  };
}

/**
 * Runs one turn: the primary model, or the fallback when the primary fails before it said or did
 * anything. A failure after that ends the turn with an error (tool calls may already have run, so
 * repeating them on another model would act twice).
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const userMessage: ModelMessage = { role: "user", content: input.userText };
  const messages = [...input.history, userMessage];
  let lastError: unknown = null;
  let actedBeforeFailing = false;
  for (const [index, model] of input.models.entries()) {
    const attempt = { emitted: false };
    input.emit({
      type: "step",
      model: model.modelId,
      ...(index > 0 ? { fellBack: true } : {}),
    });
    try {
      const out = await attemptTurn(input, model, messages, attempt);
      return {
        messages: [userMessage, ...out.messages],
        status: out.stopped ? "stopped" : "done",
        model: model.modelId,
        ...(index > 0 ? { fellBack: true } : {}),
        text: out.text,
      };
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) {
        return { messages: [userMessage], status: "stopped", model: model.modelId, text: "" };
      }
      console.warn(`assistant: ${model.provider}/${model.modelId} failed`, error);
      if (attempt.emitted) {
        actedBeforeFailing = true;
        break;
      }
    }
  }
  const message = errorMessage(lastError);
  input.emit({ type: "error", message });
  // The next turn should know this one failed, and that tools may already have run.
  const note: ModelMessage = {
    role: "assistant",
    content: actedBeforeFailing
      ? `(This answer failed partway: ${message}. Some tool calls may already have run; check before repeating them.)`
      : `(This answer failed: ${message}.)`,
  };
  return { messages: [userMessage, note], status: "error", error: message, text: "" };
}
