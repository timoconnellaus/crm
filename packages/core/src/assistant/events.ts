// What the in-app assistant streams to the UI and how a stored conversation is shown (ADR 0200).
// Browser-safe: no Workers or AI SDK imports, so the app's client bundle can use these types.

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
  | { seq: number; type: "turn-start"; turn: number; text: string; at: string }
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
    }
  | { seq: number; type: "step"; model: string; fellBack?: boolean }
  | { seq: number; type: "error"; message: string }
  | { seq: number; type: "turn-end"; status: "done" | "error" | "stopped"; at: string };

export type AssistantEventInput = AssistantEvent extends infer E
  ? E extends { seq: number }
    ? Omit<E, "seq">
    : never
  : never;

/** One item of a conversation as the UI shows it. */
export type TranscriptItem =
  | { kind: "user"; turn: number; text: string; at?: string }
  | { kind: "assistant"; turn: number; text: string }
  | {
      kind: "tool";
      turn: number;
      id: string;
      tool: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      pending?: AssistantPending;
    }
  | { kind: "error"; turn: number; message: string };

/** The state of a conversation for the UI: what is stored, plus the live turn if one is running. */
export interface AssistantConversationState {
  id: string;
  items: TranscriptItem[];
  /** The running turn and the events streamed so far (resume from the last `seq`). */
  running: { turn: number; lastSeq: number } | null;
}

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
      return [...items, { kind: "user", turn: event.turn, text: event.text, at: event.at }];
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
    case "tool-result":
      return items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? {
              ...item,
              output: event.output,
              isError: event.isError,
              ...(event.pending ? { pending: event.pending } : {}),
            }
          : item,
      );
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
