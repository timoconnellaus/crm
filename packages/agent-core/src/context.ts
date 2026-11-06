// Context assembly (ADR 0341): what a turn sends to the model.
//
//   prefix (byte-stable): system instructions → tool definitions → memory block → compaction note
//   history:              messages since the compaction, exactly as they were sent
//   tail (per turn):      pending memory lines, page context, display facts, the time
//   new message:          the tail block and the person's words, as one user message
//
// Everything that changes from turn to turn goes in the tail, so the prefix hashes the same on
// every turn and the provider's prompt cache keeps hitting. Once a user message is sent, its tail
// is part of it for good: history is replayed byte for byte.
import type { ModelMessage } from "ai";
import { type MessageVia, type NewMessage, type ThreadMessage, toModelMessage } from "./thread.ts";

/** A tool as the model sees it. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PrefixInput {
  /** The system instructions. Must not mention anything that changes per turn. */
  instructions: string;
  tools: readonly ToolDefinition[];
  /** The memory block, as of the last compaction (ADR 0342). */
  memory?: string | undefined;
  /** The "where we left off" note of the last compaction. */
  note?: string | undefined;
}

/** The order tail blocks are sent in. */
export const TAIL_ORDER = ["pending", "page", "display", "time"] as const;
export type TailKind = (typeof TAIL_ORDER)[number];

/** One block of the tail. `text` is sent as is, so it should carry its own heading. */
export interface TailBlock {
  kind: TailKind;
  text: string;
}

/** The tail's text: its blocks in `TAIL_ORDER`, blank lines between. Empty when there are none. */
export function renderTail(blocks: readonly TailBlock[]): string {
  return [...blocks]
    .filter((b) => b.text.trim())
    .sort((a, b) => TAIL_ORDER.indexOf(a.kind) - TAIL_ORDER.indexOf(b.kind))
    .map((b) => b.text.trim())
    .join("\n\n");
}

/** The system text of the prefix: instructions, then the memory block, then the note. */
export function prefixSystem(prefix: PrefixInput): string {
  const sections = [prefix.instructions.trim()];
  if (prefix.memory?.trim()) {
    sections.push(`What you remember about the person:\n${prefix.memory.trim()}`);
  }
  if (prefix.note?.trim()) {
    sections.push(
      `Where we left off (a summary of the chat before the messages below):\n${prefix.note.trim()}`,
    );
  }
  return sections.join("\n\n");
}

/** JSON with object keys sorted, so equal values always serialise to equal bytes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A hash of the prefix (system text and tool definitions, in order). Equal prefixes, equal hash. */
export async function prefixHash(prefix: PrefixInput): Promise<string> {
  return sha256(
    stableStringify({
      system: prefixSystem(prefix),
      tools: prefix.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }),
  );
}

/**
 * The reasoning policy (ADR 0201): keep reasoning only on assistant messages that made tool calls
 * (DeepSeek with thinking on rejects a follow-up without them) and drop it from plain answers,
 * which keeps prompts small. Deterministic per message, so history stays byte-stable.
 */
export function withReasoningPolicy(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant" || typeof message.content === "string") return message;
  if (message.content.some((p) => p.type === "tool-call")) return message;
  return { ...message, content: message.content.filter((p) => p.type !== "reasoning") };
}

/**
 * What the model sees of the history, with the reasoning policy applied. The history is the
 * messages since the last compaction, and compaction (ADR 0341) is what keeps it short, so by
 * default all of it is sent. A caller may pass a character budget: then only the newest whole
 * turns that fit are kept (a turn is never split, so tool calls keep their results).
 */
export function historyForModel(
  history: readonly ThreadMessage[],
  budget = Number.POSITIVE_INFINITY,
): ModelMessage[] {
  const turns = new Map<number, ModelMessage[]>();
  for (const message of history) {
    const model = toModelMessage(message);
    if (!model) continue;
    const list = turns.get(message.turn) ?? [];
    list.push(withReasoningPolicy(model));
    turns.set(message.turn, list);
  }
  const ordered = [...turns.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  const kept: ModelMessage[][] = [];
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const list = ordered[i] as ModelMessage[];
    const cost = list.reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    if (kept.length && used + cost > budget) break;
    kept.unshift(list);
    used += cost;
  }
  return kept.flat();
}

export interface AssembleInput {
  prefix: PrefixInput;
  /** Messages since the last compaction, oldest first. */
  history: readonly ThreadMessage[];
  tail: readonly TailBlock[];
  /** The person's words. */
  text: string;
  turn: number;
  via: MessageVia;
  historyBudget?: number;
}

export interface AssembledContext {
  system: string;
  tools: readonly ToolDefinition[];
  /** `prefixHash(prefix)`: a test asserts it does not change between turns. */
  prefixHash: string;
  /** The history, then the new user message. */
  messages: ModelMessage[];
  /** The new user message as it goes into the thread (the tail kept with it). */
  userMessage: NewMessage;
}

export async function assembleContext(input: AssembleInput): Promise<AssembledContext> {
  const tail = renderTail(input.tail);
  const userMessage: NewMessage = {
    turn: input.turn,
    role: "user",
    via: input.via,
    parts: [
      ...(tail ? [{ type: "context" as const, text: tail }] : []),
      { type: "text", text: input.text },
    ],
  };
  const sent = toModelMessage({ ...userMessage, seq: 0, createdAt: "" });
  return {
    system: prefixSystem(input.prefix),
    tools: input.prefix.tools,
    prefixHash: await prefixHash(input.prefix),
    messages: [...historyForModel(input.history, input.historyBudget), ...(sent ? [sent] : [])],
    userMessage,
  };
}
