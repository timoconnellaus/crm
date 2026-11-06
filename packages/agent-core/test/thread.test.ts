import { describe, expect, it } from "vitest";
import type { A2uiPart } from "@relationship-os/agent-a2ui";
import {
  addPending,
  attachCards,
  excerpt,
  ftsQuery,
  MemoryMessageStore,
  markSeen,
  messageText,
  pendingFromMessage,
  pendingTailBlock,
  readableText,
  removePending,
  runTurn,
  type ThreadMessage,
  toModelMessage,
  unreadCount,
} from "../src/index.ts";
import { fakeModel } from "./fake-model.ts";

function msg(seq: number, turn: number, role: ThreadMessage["role"], text: string): ThreadMessage {
  return {
    seq,
    turn,
    role,
    via: "text",
    parts: text ? [{ type: "text", text }] : [],
    createdAt: "",
  };
}

describe("the thread model", () => {
  it("sends a user message as one string: the tail block, then the words", () => {
    const message: ThreadMessage = {
      ...msg(1, 1, "user", "Hello"),
      parts: [
        { type: "context", text: "Current page: /" },
        { type: "text", text: "Hello" },
      ],
    };
    expect(toModelMessage(message)).toEqual({
      role: "user",
      content: "<context>\nCurrent page: /\n</context>\n\nHello",
    });
    expect(toModelMessage({ ...message, deletedAt: "2026-11-06" })).toBeNull();
    expect(toModelMessage({ ...msg(2, 1, "notice", "Saved") })).toBeNull();
  });

  it("stores, lists, deletes and searches messages", () => {
    const store = new MemoryMessageStore();
    store.append([
      {
        turn: 1,
        role: "user",
        via: "text",
        parts: [{ type: "text", text: "Has Kestrel sent the NDA?" }],
      },
      { turn: 1, role: "assistant", via: "text", parts: [{ type: "text", text: "Not yet." }] },
      {
        turn: 2,
        role: "user",
        via: "voice",
        parts: [{ type: "text", text: "Chase the Kestrel NDA Friday" }],
      },
    ]);
    expect(store.lastSeq()).toBe(3);
    expect(store.lastTurn()).toBe(2);
    expect(store.search("kestrel nda").map((h) => h.seq)).toEqual([3, 1]);
    expect(store.search("kest").map((h) => h.seq)).toEqual([3, 1]);
    store.delete([3], "2026-11-06T00:00:00Z");
    expect(store.search("kestrel").map((h) => h.seq)).toEqual([1]);
    expect(store.list().map((m) => m.seq)).toEqual([1, 2]);
    expect(store.list({ includeDeleted: true }).at(-1)?.parts).toEqual([]);
    expect(store.list({ limit: 1 }).map((m) => m.seq)).toEqual([2]);
    expect(store.list({ afterSeq: 0, limit: 1 }).map((m) => m.seq)).toEqual([1]);
  });

  it("builds FTS queries that cannot inject operators", () => {
    expect(ftsQuery('kestrel" OR nda*')).toBe('"kestrel"* "or"* "nda"*');
    expect(ftsQuery("  ")).toBeNull();
    expect(excerpt("short", ["x"])).toBe("short");
    const long = `${"a ".repeat(300)}needle ${"b ".repeat(300)}`;
    const cut = excerpt(long, ["needle"]);
    expect(cut).toContain("needle");
    expect(cut.startsWith("…")).toBe(true);
  });
});

describe("unread", () => {
  it("counts replies, not tool steps, after the last seen seq", () => {
    const messages = [
      msg(1, 1, "user", "hi"),
      msg(2, 1, "assistant", ""),
      msg(3, 1, "tool", ""),
      msg(4, 1, "assistant", "Hello"),
      msg(5, 2, "notice", "Your morning briefing"),
      msg(6, 3, "user", "thanks"),
    ];
    expect(unreadCount(messages, 0)).toBe(2);
    expect(unreadCount(messages, 4)).toBe(1);
    expect(unreadCount(messages, 6)).toBe(0);
    expect(markSeen({ lastSeenSeq: 5 }, 3)).toEqual({ lastSeenSeq: 5 });
  });
});

describe("pending lines", () => {
  it("ride in the tail until folded, and leave with their message", () => {
    let lines = addPending([], {
      id: "a",
      text: "Calls before 10",
      sourceMessageSeq: 4,
      addedAt: "1",
    });
    lines = addPending(lines, { id: "b", text: "No exclamation marks", addedAt: "2" });
    expect(pendingTailBlock(lines)?.text).toBe(
      "Also remember (saved since the memory above):\n- Calls before 10\n- No exclamation marks",
    );
    expect(pendingFromMessage(lines, 4).from.map((l) => l.id)).toEqual(["a"]);
    expect(removePending(lines, "a").map((l) => l.id)).toEqual(["b"]);
    expect(pendingTailBlock([])).toBeNull();
  });
});

describe("the turn loop", () => {
  it("falls back to the next model only when nothing has happened yet", async () => {
    const broken = fakeModel(() => ({ fail: "boom" }));
    const working = fakeModel(() => ({ text: "Hi" }));
    const events: string[] = [];
    const result = await runTurn({
      models: [
        { model: broken.model, provider: "fake", modelId: "broken", params: {} },
        { model: working.model, provider: "fake", modelId: "working", params: {} },
      ],
      system: "s",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      emit: (e) => events.push(e.type),
    });
    expect(result).toMatchObject({ status: "done", model: "working", fellBack: true, text: "Hi" });
    expect(events).toEqual(["step", "step", "text"]);
  });

  it("adds the host's fields to tool results", async () => {
    let n = 0;
    const { model } = fakeModel(() =>
      n++ === 0 ? { toolCall: { name: "act", arguments: {} } } : { text: "Waiting." },
    );
    const results: unknown[] = [];
    await runTurn<{ pending: string }>({
      models: [{ model, provider: "fake", modelId: "m", params: {} }],
      system: "s",
      messages: [{ role: "user", content: "do it" }],
      tools: [
        {
          name: "act",
          description: "Acts.",
          inputSchema: { type: "object", properties: {} },
          call: async () => ({ text: '{"status":"pending_approval"}', isError: false }),
        },
      ],
      describeResult: (output) =>
        (output as { status?: string }).status === "pending_approval"
          ? { pending: "yes" }
          : undefined,
      emit: (e) => {
        if (e.type === "tool-result") results.push(e);
      },
    });
    expect(results).toEqual([
      expect.objectContaining({ tool: "act", isError: false, pending: "yes" }),
    ]);
  });

  it("ends with a note when every model fails", async () => {
    const broken = fakeModel(() => ({ fail: "down" }));
    const result = await runTurn({
      models: [{ model: broken.model, provider: "fake", modelId: "b", params: {} }],
      system: "s",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      emit: () => {},
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result.response)).toContain("This answer failed");
  });
});

describe("cards in the thread (ADR 0346)", () => {
  const card: A2uiPart = {
    type: "a2ui",
    source: "model",
    document: { a2ui: 1, root: { type: "heading", text: "Your tasks" } },
    fallback: "1. Call Ada",
  };
  const base = { seq: 1, turn: 1, via: "text" as const, createdAt: "2026-11-06T00:00:00Z" };

  it("sends a posted card to the model as its fallback, so it can say 'the first task'", () => {
    const message: ThreadMessage = { ...base, role: "assistant", parts: [card] };
    expect(toModelMessage(message)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "1. Call Ada" }],
    });
  });

  it("does not repeat a tool's card: the model read it in the tool result", () => {
    const message: ThreadMessage = {
      ...base,
      role: "tool",
      parts: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "show_card",
          output: { type: "text", value: "shown" },
        },
        card,
      ],
    };
    const sent = toModelMessage(message);
    expect(sent?.content).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("Call Ada");
  });

  it("indexes a card's fallback, so search finds it", () => {
    const store = new MemoryMessageStore();
    store.append([{ turn: 1, role: "assistant", via: "routine", parts: [card] }]);
    expect(store.search("Ada", 5).map((h) => h.text)).toEqual(["1. Call Ada"]);
  });

  it("counts a card as something to read", () => {
    const stored = (role: ThreadMessage["role"]): ThreadMessage => ({
      ...base,
      role,
      parts: [card],
    });
    expect(unreadCount([stored("assistant")], 0)).toBe(1);
    expect(unreadCount([stored("tool")], 0)).toBe(1);
    expect(readableText(stored("assistant"))).toBe("1. Call Ada");
    expect(messageText(stored("assistant"))).toBe("");
  });

  it("puts each card beside the tool result that made it", () => {
    const result = (id: string) => ({
      type: "tool-result" as const,
      toolCallId: id,
      toolName: "show_card",
      output: {},
    });
    const messages = [
      { turn: 1, role: "assistant" as const, via: "text" as const, parts: [] },
      { turn: 1, role: "tool" as const, via: "text" as const, parts: [result("a"), result("b")] },
    ];
    const out = attachCards(messages, new Map([["a", card]]));
    expect(out[1]?.parts.map((p) => p.type)).toEqual(["tool-result", "a2ui", "tool-result"]);
    expect(attachCards(messages, new Map())).toEqual(messages);
  });
});
