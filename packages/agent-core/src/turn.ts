// The turn loop (ADR 0340): one turn of the thread over an injected model and tool set, with the
// AI SDK, until the model answers in text or runs out of steps, emitting events as it goes. The
// host owns storage, streaming to readers and where the tools come from (the CRM uses its own MCP
// server, in process). Fallback models are tried only when the one before failed before saying or
// doing anything, so a tool call never runs twice.
import {
  dynamicTool,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import type { ToolDefinition } from "./context.ts";

type StreamTextOptions = Parameters<typeof streamText>[0];

/** A model to run a turn on, resolved by the host from a role (never a model id in code). */
export interface TurnModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
  params: { maxTokens?: number | undefined; temperature?: number | undefined };
  providerOptions?: StreamTextOptions["providerOptions"];
  headers?: Record<string, string>;
}

/** A tool the model may call. */
export interface TurnTool extends ToolDefinition {
  /**
   * `text` is the result. `modelText`, when set, is what the model reads instead: a card's result
   * holds the whole card for the reader, and the model needs only its text fallback.
   */
  call(
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; modelText?: string }>;
}

/** What a turn emits, in order. `X` is what the host adds to a tool result (e.g. a pending approval). */
export type TurnEvent<X extends object = Record<never, never>> =
  | { type: "text"; delta: string }
  /** The model is reasoning. Its content is not streamed, only that it is happening. */
  | { type: "thinking" }
  | { type: "tool-call"; id: string; tool: string; input: unknown }
  | ({
      type: "tool-result";
      id: string;
      tool: string;
      output: unknown;
      isError: boolean;
    } & Partial<X>)
  | { type: "step"; model: string; fellBack?: boolean }
  | { type: "error"; message: string };

export interface TurnInput<X extends object = Record<never, never>> {
  /** The role's models, primary first. */
  models: readonly TurnModel[];
  system: string;
  /** The history and the new user message (`assembleContext().messages`). */
  messages: readonly ModelMessage[];
  tools: readonly TurnTool[];
  emit: (event: TurnEvent<X>) => void;
  /** Extra fields for a tool-result event, from the parsed output. */
  describeResult?: (output: unknown, isError: boolean) => Partial<X> | undefined;
  /** Model steps per turn (each step may call tools). */
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface TurnResult {
  /** The model's and tools' messages, to store after the user message. */
  response: ModelMessage[];
  status: "done" | "error" | "stopped";
  model?: string;
  fellBack?: boolean;
  error?: string;
  /** The turn's final text. */
  text: string;
}

export const DEFAULT_MAX_STEPS = 16;
/** A tool result longer than this is cut before the model sees it. */
export const TOOL_RESULT_MAX_CHARS = 24_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The model call failed";
}

/** Parses a tool's text result as JSON when it is JSON. */
export function parseToolOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function toolSet<X extends object>(input: TurnInput<X>, attempt: { emitted: boolean }): ToolSet {
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
        let result: Awaited<ReturnType<TurnTool["call"]>>;
        try {
          result = await t.call(callArgs);
        } catch (error) {
          result = {
            text: JSON.stringify({ error: { message: errorMessage(error) } }),
            isError: true,
          };
        }
        const output = parseToolOutput(result.text);
        const extra = input.describeResult?.(output, result.isError);
        input.emit({
          type: "tool-result",
          id: options.toolCallId,
          tool: t.name,
          output,
          isError: result.isError,
          ...(extra ?? {}),
        } as TurnEvent<X>);
        const said = result.modelText ?? result.text;
        const text =
          said.length > TOOL_RESULT_MAX_CHARS
            ? `${said.slice(0, TOOL_RESULT_MAX_CHARS)}… (cut: ${said.length} characters; ask for less)`
            : said;
        return result.isError ? `ERROR: ${text}` : text;
      },
    });
  }
  return tools;
}

async function attemptTurn<X extends object>(
  input: TurnInput<X>,
  model: TurnModel,
  attempt: { emitted: boolean },
): Promise<{ messages: ModelMessage[]; text: string; stopped: boolean }> {
  let streamError: unknown = null;
  let thinking = false;
  let text = "";
  const result = streamText({
    model: model.model,
    instructions: input.system,
    messages: [...input.messages],
    tools: toolSet(input, attempt),
    stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_MAX_STEPS),
    ...(model.params.maxTokens !== undefined ? { maxOutputTokens: model.params.maxTokens } : {}),
    ...(model.params.temperature !== undefined ? { temperature: model.params.temperature } : {}),
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
 * Runs one turn: the primary model, or the next when one failed before it said or did anything.
 * A failure after that ends the turn with an error (tool calls may already have run, so repeating
 * them on another model would act twice); the response then holds a note saying so, so the next
 * turn knows.
 */
export async function runTurn<X extends object = Record<never, never>>(
  input: TurnInput<X>,
): Promise<TurnResult> {
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
      const out = await attemptTurn(input, model, attempt);
      return {
        response: out.messages,
        status: out.stopped ? "stopped" : "done",
        model: model.modelId,
        ...(index > 0 ? { fellBack: true } : {}),
        text: out.text,
      };
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) {
        return { response: [], status: "stopped", model: model.modelId, text: "" };
      }
      console.warn(`turn: ${model.provider}/${model.modelId} failed`, error);
      if (attempt.emitted) {
        actedBeforeFailing = true;
        break;
      }
    }
  }
  const message = input.models.length ? errorMessage(lastError) : "No model is configured";
  input.emit({ type: "error", message });
  const note: ModelMessage = {
    role: "assistant",
    content: actedBeforeFailing
      ? `(This answer failed partway: ${message}. Some tool calls may already have run; check before repeating them.)`
      : `(This answer failed: ${message}.)`,
  };
  return { response: [note], status: "error", error: message, text: "" };
}
