// The thread's stored messages, for the CRM (ADR 0200, ADR 0201, ADR 0340). The thread model,
// context assembly and the reasoning policy live in @relationship-os/agent-core; this module says
// how the thread is shown in the app and what counts as the person's own words.
import { messageText, type ThreadMessage, withReasoningPolicy } from "@relationship-os/agent-core";
import type { ModelMessage } from "ai";
import {
  type AssistantPending,
  parseToolOutput,
  pendingOf,
  type TranscriptItem,
} from "./events.ts";

export { withReasoningPolicy };

/** A model message and the turn it belongs to (the person's words, for `personsWords`). */
export interface StoredMessage {
  turn: number;
  message: ModelMessage;
}

/**
 * The person's own words in the thread (ADR 0230, `authoring.intent`): the text of every user
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

/** The person's words in thread messages (their text parts, never the tail block). */
export function personsWordsInThread(
  messages: readonly ThreadMessage[],
  current: string,
  max = 4_000,
): string {
  return personsWords(
    messages
      .filter((m) => m.role === "user" && !m.deletedAt)
      .map((m) => ({ turn: m.turn, message: { role: "user", content: messageText(m) } })),
    current,
    max,
  );
}

function toolResultView(output: unknown): { output: unknown; isError: boolean } {
  const out = output as { type?: string; value?: unknown } | null;
  switch (out?.type) {
    case "text":
      return { output: parseToolOutput(String(out.value ?? "")), isError: false };
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

/**
 * The thread as the UI shows it: the person's words, the assistant's text (one item per reply),
 * tool calls with their results and any pending change, and cards. Each item carries the seq of its first
 * stored message, so it can be deleted or jumped to.
 */
export function transcriptFromThread(messages: readonly ThreadMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const message of messages) {
    if (message.deletedAt) continue;
    const { turn, seq, createdAt: at } = message;
    if (message.role === "user") {
      items.push({
        kind: "user",
        turn,
        seq,
        at,
        text: messageText(message),
        ...(message.via !== "text" ? { via: message.via } : {}),
      });
    } else if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.type === "a2ui") {
          items.push({ kind: "card", turn, seq, at, part });
        } else if (part.type === "text" && part.text.trim()) {
          const last = items[items.length - 1];
          if (last?.kind === "assistant" && last.turn === turn) last.text += part.text;
          else items.push({ kind: "assistant", turn, seq, at, text: part.text });
          const reply = items[items.length - 1] as Extract<TranscriptItem, { kind: "assistant" }>;
          if (message.via === "voice") reply.spoken = true;
          if (message.playout) reply.playout = message.playout;
        } else if (part.type === "tool-call") {
          const item = {
            kind: "tool" as const,
            turn,
            seq,
            at,
            id: part.toolCallId,
            tool: part.toolName,
            input: part.input,
          };
          tools.set(part.toolCallId, item);
          items.push(item);
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type === "a2ui") items.push({ kind: "card", turn, seq, at, part });
        if (part.type !== "tool-result") continue;
        const item = tools.get(part.toolCallId);
        if (!item) continue;
        const { output, isError } = toolResultView(part.output);
        item.output = output;
        item.isError = isError;
        const pending: AssistantPending | undefined = isError ? undefined : pendingOf(output);
        if (pending) item.pending = pending;
      }
    }
  }
  return items;
}
