// What the in-app assistant streams to the UI and how its thread is shown (ADR 0200, ADR 0340).
// Browser-safe: no Workers or AI SDK imports, so the app's client bundle can use these types.
import type { A2uiPart } from "@relationship-os/agent-a2ui";
import type { Playout } from "@relationship-os/agent-core";
import type { AssistantContext } from "./context.ts";

/** A pending change the assistant's tool call created (the MCP `pending_approval` result). */
export interface AssistantPending {
  actionId: string;
  changeSetId: string;
  operation: string;
  message: string;
  expiresAt?: string;
}

/** One event of a turn, in order. `seq` numbers events within the turn from 1. */
export type AssistantEvent =
  | { seq: number; type: "turn-start"; turn: number; text: string; at: string; via?: string }
  | { seq: number; type: "text"; delta: string }
  /** The model is reasoning (thinking). Content is not streamed, only that it is happening. */
  | { seq: number; type: "thinking" }
  | { seq: number; type: "tool-call"; id: string; tool: string; input: unknown }
  | {
      seq: number;
      type: "tool-result";
      id: string;
      tool: string;
      output: unknown;
      isError: boolean;
      pending?: AssistantPending;
      /** The card this tool call made (ADR 0346). */
      card?: A2uiPart;
    }
  | { seq: number; type: "step"; model: string; fellBack?: boolean }
  | { seq: number; type: "error"; message: string }
  | { seq: number; type: "turn-end"; status: "done" | "error" | "stopped"; at: string };

export type AssistantEventInput = AssistantEvent extends infer E
  ? E extends { seq: number }
    ? Omit<E, "seq">
    : never
  : never;

/** Where a thread item sits: its first stored message (`seq`) and when it was written. */
interface Placed {
  /** The first stored message of the item; absent while its turn is still streaming. */
  seq?: number;
  /** ISO time it was written. */
  at?: string;
}

/** One item of the thread as the UI shows it. */
export type TranscriptItem =
  | ({ kind: "user"; turn: number; text: string; via?: string } & Placed)
  | ({
      kind: "assistant";
      turn: number;
      text: string;
      /** What was heard of a spoken reply (ADR 0349). */
      playout?: Playout;
      /** The reply was spoken: the chat says how much was. */
      spoken?: boolean;
    } & Placed)
  | ({
      kind: "tool";
      turn: number;
      id: string;
      tool: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      pending?: AssistantPending;
    } & Placed)
  /** A card (ADR 0346), or just its text fallback when it cannot be drawn. */
  | ({ kind: "card"; turn: number; part: A2uiPart } & Placed)
  | ({ kind: "error"; turn: number; message: string } & Placed);

/** The thread for the UI: a window of stored items, plus the live turn if one is running. */
export interface AssistantThreadState {
  /** The thread id (ath_…), or null before the first turn. */
  id: string | null;
  items: TranscriptItem[];
  /** The running turn, and the events it has streamed so far (replay them, then follow). */
  running: { turn: number; lastSeq: number; events: AssistantEvent[] } | null;
  /** The oldest seq in `items` (null when empty); earlier messages exist when `hasEarlier`. */
  firstSeq: number | null;
  hasEarlier: boolean;
  /** The newest stored seq. */
  lastSeq: number;
  lastSeenSeq: number;
  unread: number;
}

/** A hit of "Search this chat" (`thread.search`). */
export interface ThreadSearchHit {
  seq: number;
  turn: number;
  role: "user" | "assistant" | "tool" | "notice";
  at: string;
  /** The message's words, cut to about 300 characters around the first match. */
  text: string;
}

/** What the browser sends over the thread's WebSocket. */
export type ThreadClientFrame =
  /** A new message from the person. */
  | { type: "send"; text: string; context?: AssistantContext; dictated?: boolean }
  /** Stop the running reply. */
  | { type: "stop" }
  /** Ask for the thread: the newest window, or the window before `beforeSeq`, or from `fromSeq`. */
  | { type: "sync"; beforeSeq?: number; fromSeq?: number }
  /** Whether the chat is on screen on this device (replies then arrive already seen). */
  | { type: "visible"; visible: boolean };

/** What the thread sends to the browser over its WebSocket. */
export type ThreadServerFrame =
  /** The thread: `replace` the view, or `prepend` an earlier window. */
  | { type: "state"; state: AssistantThreadState; mode: "replace" | "prepend" }
  /** One event of the running turn (whichever device started it). */
  | { type: "event"; event: AssistantEvent }
  | { type: "unread"; unread: number; lastSeenSeq: number }
  /** Messages were deleted (on any device). */
  | { type: "deleted"; seqs: number[] }
  /** What was heard of a turn's spoken reply. */
  | { type: "playout"; turn: number; playout: Playout }
  /** Something was added outside a turn (a card a routine posted): read the thread again. */
  | { type: "appended" }
  /** An agent moved on: read its card again (ADR 0344). */
  | { type: "job"; jobId: string }
  | { type: "error"; message: string };

/** Recognises an MCP `pending_approval` tool result (PendingApproval in errors.ts). */
export function pendingOf(output: unknown): AssistantPending | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.status !== "pending_approval") return undefined;
  if (typeof o.actionId !== "string" || typeof o.changeSetId !== "string") return undefined;
  return {
    actionId: o.actionId,
    changeSetId: o.changeSetId,
    operation: typeof o.operation === "string" ? o.operation : "",
    message: typeof o.message === "string" ? o.message : "Waiting for approval",
    ...(typeof o.expiresAt === "string" ? { expiresAt: o.expiresAt } : {}),
  };
}

/** What an operation that makes a card returns (`a2ui.show`, `a2ui.produce`). */
export const CARD_STATUS = "a2ui_card" as const;

export interface CardResult {
  status: typeof CARD_STATUS;
  part: A2uiPart;
}

/** Recognises a card in a tool result. */
export function cardOf(output: unknown): A2uiPart | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Partial<CardResult>;
  if (o.status !== CARD_STATUS) return undefined;
  const part = o.part as Partial<A2uiPart> | undefined;
  if (part?.type !== "a2ui" || typeof part.fallback !== "string") return undefined;
  return part as A2uiPart;
}

/**
 * What the model reads for a card: its text fallback, so it can refer to "the second task", and
 * the problems when its card was not shown. Never the document: the model does not need it again.
 */
export function cardModelText(part: A2uiPart): string {
  return JSON.stringify(
    part.document
      ? { status: "shown", text: part.fallback }
      : { status: "not_shown", shownAsText: part.fallback, problems: part.problems ?? [] },
  );
}

/** A memory line as a tool result carries it, for the line under a reply. */
export interface AssistantMemoryLine {
  id: string;
  kind: string;
  text: string;
  status: string;
  condition: unknown;
  conditionLabel: string | null;
  source: { threadId: string; messageSeq: number } | null;
  activeSince: string | null;
}

/** What `memory.propose` and `teamMemory.propose` returned, for the UI under the reply. */
export interface AssistantMemorySave {
  result: "saved" | "confirm" | "awaiting_approval";
  line: AssistantMemoryLine;
  checked: "judge" | "deterministic" | "person";
}

/** Recognises a memory save in a tool result (nothing for one that saved no line). */
export function memorySaveOf(output: unknown): AssistantMemorySave | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.result !== "saved" && o.result !== "confirm" && o.result !== "awaiting_approval") {
    return undefined;
  }
  const line = o.line as AssistantMemoryLine | null | undefined;
  if (!line || typeof line !== "object" || typeof line.id !== "string") return undefined;
  if (!line.id.startsWith("mem_")) return undefined;
  return o as unknown as AssistantMemorySave;
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

/** Folds a turn's events into transcript items (the UI's live view of a running turn). */
export function applyEvent(items: TranscriptItem[], event: AssistantEvent): TranscriptItem[] {
  switch (event.type) {
    case "turn-start":
      return [
        ...items,
        {
          kind: "user",
          turn: event.turn,
          text: event.text,
          at: event.at,
          ...(event.via ? { via: event.via } : {}),
        },
      ];
    case "text": {
      const last = items[items.length - 1];
      const turn = currentTurn(items);
      if (last?.kind === "assistant") {
        return [...items.slice(0, -1), { ...last, text: last.text + event.delta }];
      }
      return [...items, { kind: "assistant", turn, text: event.delta }];
    }
    case "tool-call":
      return [
        ...items,
        {
          kind: "tool",
          turn: currentTurn(items),
          id: event.id,
          tool: event.tool,
          input: event.input,
        },
      ];
    case "tool-result": {
      const updated = items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? {
              ...item,
              output: event.output,
              isError: event.isError,
              ...(event.pending ? { pending: event.pending } : {}),
            }
          : item,
      );
      return event.card
        ? [...updated, { kind: "card", turn: currentTurn(items), part: event.card }]
        : updated;
    }
    case "error":
      return [...items, { kind: "error", turn: currentTurn(items), message: event.message }];
    default:
      return items;
  }
}

function currentTurn(items: TranscriptItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "user") return item.turn;
  }
  return 0;
}
