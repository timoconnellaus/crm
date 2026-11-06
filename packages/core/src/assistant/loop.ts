// One turn of the in-app assistant (ADR 0200, ADR 0340): the `assistant.core` role's models with
// the CRM's MCP tools. The loop itself is agent-core's `runTurn`; this binds it to the CRM: a tool
// result that is an MCP `pending_approval` envelope becomes the event's `pending`, so the UI can
// show Approve and Reject.
import { runTurn, type TurnTool } from "@relationship-os/agent-core";
import type { ModelMessage } from "ai";
import type { ChatModel } from "../ai/client.ts";
import { type AssistantEventInput, type AssistantPending, pendingOf } from "./events.ts";

/** A tool the assistant may call: one MCP tool of our own /mcp. */
export type AssistantTool = TurnTool;

export {
  DEFAULT_MAX_STEPS as ASSISTANT_MAX_STEPS,
  TOOL_RESULT_MAX_CHARS,
} from "@relationship-os/agent-core";

export interface AssistantTurnInput {
  /** The role's models, primary first (ModelRunner.chatModels). */
  models: readonly ChatModel[];
  instructions: string;
  /** Earlier messages, as they are to be sent. */
  history: readonly ModelMessage[];
  /** The new user message: the person's words, or the tail block and the words. */
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
  /** The final text of the turn. */
  text: string;
}

/** Recognises a pending change in a tool result (agent-core's `describeResult` for the CRM). */
export function describeAssistantResult(
  output: unknown,
  isError: boolean,
): { pending: AssistantPending } | undefined {
  const pending = isError ? undefined : pendingOf(output);
  return pending ? { pending } : undefined;
}

/**
 * Runs one turn: the primary model, or the fallback when the primary failed before it said or
 * did anything (see agent-core's `runTurn`).
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const userMessage: ModelMessage = { role: "user", content: input.userText };
  const result = await runTurn<{ pending: AssistantPending }>({
    models: input.models,
    system: input.instructions,
    messages: [...input.history, userMessage],
    tools: input.tools,
    emit: (event) => input.emit(event as AssistantEventInput),
    describeResult: describeAssistantResult,
    ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    messages: [userMessage, ...result.response],
    status: result.status,
    ...(result.model ? { model: result.model } : {}),
    ...(result.fellBack ? { fellBack: true } : {}),
    ...(result.error ? { error: result.error } : {}),
    text: result.text,
  };
}
