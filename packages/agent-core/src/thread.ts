// The thread model (ADR 0340): one long-lived chat per person. A thread is an append-only list of
// messages numbered by `seq`. Each message keeps the parts it was made of: what the person typed,
// the tail block it was sent with, the model's text, reasoning and tool calls, tool results, and
// notices. The parts map one to one onto AI SDK model messages, so what was sent to the model is
// what is replayed to it on the next turn (reasoning included, ADR 0201), and the prefix of the
// conversation stays byte-stable for prompt caching (ADR 0341).
import type { ModelMessage } from "ai";

/** How a message reached the thread. */
export const MESSAGE_VIAS = [
  "text",
  "voice",
  "dictation",
  "routine",
  "agent",
  "connected",
] as const;
export type MessageVia = (typeof MESSAGE_VIAS)[number];

/** What a spoken message's playout was: the model only sees what was heard (W9). */
export type Playout =
  | { state: "spoken" }
  | { state: "partly_spoken"; unsaid: string }
  | { state: "unspoken" };

export type MessageRole = "user" | "assistant" | "tool" | "notice";

/** Provider-specific metadata the AI SDK keeps on a part (signatures and the like). */
export type ProviderOptions = Record<string, Record<string, unknown>>;

/** A part of a message. */
export type MessagePart =
  /** Words: the person's, or the model's answer. Indexed for search. */
  | { type: "text"; text: string }
  /**
   * The tail block a user message was sent with (page context, pending lines, display facts).
   * Sent to the model as part of that message, never shown or indexed.
   */
  | { type: "context"; text: string }
  | { type: "reasoning"; text: string; providerOptions?: ProviderOptions }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerOptions?: ProviderOptions;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      /** The AI SDK tool result output, as the model saw it. */
      output: unknown;
    }
  /** A line the host shows in the thread ("Saved to memory · undo"); not sent to the model. */
  | { type: "notice"; kind: string; text: string; data?: unknown };

export interface ThreadMessage {
  seq: number;
  /** The turn that wrote it: a user message and everything that answered it share a turn. */
  turn: number;
  role: MessageRole;
  via: MessageVia;
  parts: MessagePart[];
  playout?: Playout | undefined;
  /** ISO time it was written. */
  createdAt: string;
  /** ISO time it was deleted; deleted messages are never sent or shown. */
  deletedAt?: string | undefined;
}

export type NewMessage = Omit<ThreadMessage, "seq" | "createdAt" | "deletedAt"> & {
  createdAt?: string;
};

/** The person-visible words of a message (its text parts), for search, previews and unread. */
export function messageText(message: Pick<ThreadMessage, "parts">): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

/** The tail block a user message is sent with, wrapped so the model can tell it from the words. */
export function wrapTail(tail: string): string {
  return `<context>\n${tail.trim()}\n</context>`;
}

function userContent(message: ThreadMessage): string {
  const context = message.parts.filter((p) => p.type === "context").map((p) => wrapTail(p.text));
  const text = messageText(message);
  return [...context, text].filter(Boolean).join("\n\n");
}

function withOptions<T extends object>(part: T, providerOptions: ProviderOptions | undefined): T {
  return providerOptions ? { ...part, providerOptions } : part;
}

/**
 * A thread message as the AI SDK model message it was (or will be) sent as. Notices and deleted
 * messages have none. A user message is always a single string: the tail block, then the words.
 */
const SAY_OPEN = "<say>";
const SAY_CLOSE = "</say>";
const CUT_OFF = "[The person spoke over the rest and did not hear it.]";
const NOT_HEARD = "[The person spoke over this before hearing any of it.]";

/**
 * What the model is shown of a spoken reply: only what was heard (ADR 0349, decision 7). A
 * `<say>` block is what was spoken, and the answer after it was on the person's screen, so only
 * the block is cut. Without one, the reply itself was spoken and is cut where it stopped.
 * `unsaid` is the words as they went to speech, so Markdown can keep it from matching exactly;
 * then the model is told which words were missed.
 */
export function heardReply(text: string, playout: Playout | undefined): string {
  if (!playout || playout.state === "spoken") return text;
  const open = text.indexOf(SAY_OPEN);
  const close = open < 0 ? -1 : text.indexOf(SAY_CLOSE, open);
  const start = close < 0 ? 0 : open + SAY_OPEN.length;
  const end = close < 0 ? text.length : close;
  if (playout.state === "unspoken") {
    return close < 0 ? NOT_HEARD : `${text.slice(0, start)}${NOT_HEARD}${text.slice(end)}`;
  }
  const opening = playout.unsaid.split(/\s+/).slice(0, 3).join(" ");
  const at = text.slice(start, end).lastIndexOf(opening);
  if (!opening || at < 0) return `${text}\n[The person did not hear: "${playout.unsaid}"]`;
  return `${text.slice(0, start + at).trimEnd()} ${CUT_OFF}${text.slice(end)}`;
}

export function toModelMessage(message: ThreadMessage): ModelMessage | null {
  if (message.deletedAt) return null;
  switch (message.role) {
    case "user": {
      const content = userContent(message);
      return content ? { role: "user", content } : null;
    }
    case "assistant": {
      const content: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> = [];
      const lastText = message.parts.findLastIndex((part) => part.type === "text");
      for (const [index, part] of message.parts.entries()) {
        if (part.type === "text") {
          const text = index === lastText ? heardReply(part.text, message.playout) : part.text;
          content.push({ type: "text", text });
        }
        if (part.type === "reasoning") {
          content.push(withOptions({ type: "reasoning", text: part.text }, part.providerOptions));
        } else if (part.type === "tool-call") {
          content.push(
            withOptions(
              {
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              },
              part.providerOptions,
            ),
          );
        }
      }
      return content.length ? { role: "assistant", content } : null;
    }
    case "tool": {
      const content = message.parts.flatMap((part) =>
        part.type === "tool-result"
          ? [
              {
                type: "tool-result" as const,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: part.output as Extract<
                  Extract<ModelMessage, { role: "tool" }>["content"][number],
                  { type: "tool-result" }
                >["output"],
              },
            ]
          : [],
      );
      return content.length ? { role: "tool", content } : null;
    }
    default:
      return null;
  }
}

/** The parts of an AI SDK model message (a turn's response), to store in the thread. */
export function partsFromModelMessage(message: ModelMessage): MessagePart[] {
  if (typeof message.content === "string") {
    return message.content ? [{ type: "text", text: message.content }] : [];
  }
  const parts: MessagePart[] = [];
  for (const part of message.content) {
    const options = (part as { providerOptions?: ProviderOptions }).providerOptions;
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "reasoning":
        parts.push(withOptions({ type: "reasoning" as const, text: part.text }, options));
        break;
      case "tool-call":
        parts.push(
          withOptions(
            {
              type: "tool-call" as const,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            },
            options,
          ),
        );
        break;
      case "tool-result":
        parts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
        });
        break;
      default:
        // Files, images and approval parts are not produced by the turn loop yet.
        break;
    }
  }
  return parts;
}

/** Thread messages for a turn's response messages (assistant and tool). */
export function messagesFromResponse(
  turn: number,
  via: MessageVia,
  response: readonly ModelMessage[],
): NewMessage[] {
  const out: NewMessage[] = [];
  for (const message of response) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    const parts = partsFromModelMessage(message);
    if (parts.length) out.push({ turn, role: message.role, via, parts });
  }
  return out;
}
