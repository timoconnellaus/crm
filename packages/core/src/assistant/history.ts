// A conversation's durable history (ADR 0200, ADR 0201). The conversation object stores the AI
// SDK's model messages exactly as each turn produced them, reasoning parts included, and this
// module decides what is sent back to the model on the next turn and how it is shown.
//
// Reasoning content (ADR 0201): DeepSeek with thinking on rejects a follow-up request with HTTP
// 400 unless every earlier assistant turn that made tool calls carries its `reasoning_content`.
// `@ai-sdk/openai-compatible` sends an assistant message's reasoning parts as `reasoning_content`,
// so keeping those parts is enough. Reasoning of a turn that ended in plain text is never needed
// again and is dropped from what is sent (it is still stored), which keeps prompts small.
import type {
  AssistantModelMessage as AssistantMessage,
  ModelMessage,
  ToolModelMessage as ToolMessage,
} from "ai";
import {
  type AssistantPending,
  parseToolOutput,
  pendingOf,
  type TranscriptItem,
} from "./events.ts";

/** A stored message and the turn it belongs to. */
export interface StoredMessage {
  turn: number;
  message: ModelMessage;
}

/** About 60k tokens of history at most; older whole turns are left out first. */
export const HISTORY_CHAR_BUDGET = 240_000;

function hasToolCalls(message: AssistantMessage): boolean {
  return typeof message.content !== "string" && message.content.some((p) => p.type === "tool-call");
}

/** The reasoning policy: keep reasoning only on assistant messages that made tool calls. */
export function withReasoningPolicy(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant" || typeof message.content === "string") return message;
  if (hasToolCalls(message)) return message;
  const content = message.content.filter((p) => p.type !== "reasoning");
  return { ...message, content };
}

/**
 * The person's own words in a conversation (ADR 0230, `authoring.intent`): the text of every user
 * message, oldest first, with this turn's last, kept to the newest `max` characters. Built by code
 * from what the person typed; nothing a model wrote is in it.
 */
export function personsWords(
  stored: readonly StoredMessage[],
  current: string,
  max = 4_000,
): string {
  const said: string[] = [];
  for (const { message } of stored) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((p) => (p.type === "text" ? p.text : ""))
            .filter(Boolean)
            .join("\n");
    if (text.trim()) said.push(text.trim());
  }
  if (current.trim()) said.push(current.trim());
  const all = said.join("\n\n");
  return all.length <= max ? all : all.slice(all.length - max);
}

function size(message: ModelMessage): number {
  return JSON.stringify(message.content).length;
}

/**
 * What the model sees of the stored history: the reasoning policy applied, then the newest whole
 * turns that fit the budget (a turn is never split, so tool calls keep their results).
 */
export function messagesForModel(
  stored: readonly StoredMessage[],
  budget = HISTORY_CHAR_BUDGET,
): ModelMessage[] {
  const turns = new Map<number, ModelMessage[]>();
  for (const { turn, message } of stored) {
    const list = turns.get(turn) ?? [];
    list.push(withReasoningPolicy(message));
    turns.set(turn, list);
  }
  const ordered = [...turns.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  const kept: ModelMessage[][] = [];
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const list = ordered[i] as ModelMessage[];
    const cost = list.reduce((n, m) => n + size(m), 0);
    if (kept.length && used + cost > budget) break;
    kept.unshift(list);
    used += cost;
  }
  return kept.flat();
}

function toolResultText(part: ToolMessage["content"][number]): {
  output: unknown;
  isError: boolean;
} {
  if (part.type !== "tool-result") return { output: null, isError: false };
  const out = part.output;
  switch (out.type) {
    case "text":
      return { output: parseToolOutput(out.value), isError: false };
    case "error-text":
      return { output: out.value, isError: true };
    case "json":
      return { output: out.value, isError: false };
    case "error-json":
      return { output: out.value, isError: true };
    default:
      return { output: null, isError: false };
  }
}

/** The stored history as the UI shows it: user and assistant text, tool calls with results. */
export function transcriptFromMessages(stored: readonly StoredMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const { turn, message } of stored) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("")
              .trim();
      items.push({ kind: "user", turn, text });
    } else if (message.role === "assistant") {
      const parts =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      for (const part of parts) {
        if (part.type === "text" && part.text.trim()) {
          const last = items[items.length - 1];
          if (last?.kind === "assistant" && last.turn === turn) last.text += part.text;
          else items.push({ kind: "assistant", turn, text: part.text });
        } else if (part.type === "tool-call") {
          const item = {
            kind: "tool" as const,
            turn,
            id: part.toolCallId,
            tool: part.toolName,
            input: part.input,
          };
          tools.set(part.toolCallId, item);
          items.push(item);
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const item = tools.get(part.toolCallId);
        if (!item) continue;
        const { output, isError } = toolResultText(part);
        item.output = output;
        item.isError = isError;
        const pending: AssistantPending | undefined = pendingOf(output);
        if (pending) item.pending = pending;
      }
    }
  }
  return items;
}
