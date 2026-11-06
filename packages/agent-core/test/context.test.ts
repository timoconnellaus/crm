// Context assembly keeps a byte-stable prefix across turns (stage 17, acceptance 2): the prefix
// hash does not change while the tail (pending lines, page context, display facts) does, the
// system text sent to the model is identical every turn, and each request starts with the
// previous request's messages byte for byte.
import { describe, expect, it } from "vitest";
import {
  assembleContext,
  historyForModel,
  MemoryMessageStore,
  messagesFromResponse,
  type PrefixInput,
  pendingTailBlock,
  prefixHash,
  renderTail,
  runTurn,
  stableStringify,
  type TailBlock,
  type TurnTool,
} from "../src/index.ts";
import { fakeModel } from "./fake-model.ts";

const lookup: TurnTool = {
  name: "lookup",
  description: "Looks a record up by name.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  async call(args) {
    return { text: JSON.stringify({ found: String(args.q) }), isError: false };
  },
};

const prefix: PrefixInput = {
  instructions: "You are the assistant. Be brief.",
  tools: [lookup],
  memory: "- Prefers calls before 10",
};

describe("context assembly", () => {
  it("keeps the prefix byte-stable across turns while the tail changes", async () => {
    const store = new MemoryMessageStore();
    // Turn 1 calls a tool, later turns answer in text.
    const { model, requests } = fakeModel((request) => {
      const last = request.messages.at(-1);
      if (last?.role === "user" && String(last.content).includes("look up")) {
        return { toolCall: { name: "lookup", arguments: { q: "Ada" } } };
      }
      return { text: last?.role === "tool" ? "Found Ada." : "Sure." };
    });
    const turns: { text: string; tail: TailBlock[] }[] = [
      {
        text: "Please look up Ada",
        tail: [
          { kind: "page", text: "Current page: /people/per_1" },
          { kind: "time", text: "Now: 2026-11-06T09:00:00Z" },
        ],
      },
      {
        text: "Thanks",
        tail: [
          pendingTailBlock([
            { id: "m1", text: "No exclamation marks", addedAt: "2026-11-06T09:01:00Z" },
          ]) as TailBlock,
          { kind: "page", text: "Current page: /organisations/org_9" },
          { kind: "time", text: "Now: 2026-11-06T09:02:00Z" },
        ],
      },
      { text: "And again", tail: [{ kind: "display", text: "The person can see cards." }] },
    ];
    const hashes: string[] = [];
    const systems: string[] = [];
    const sent: string[][] = [];
    for (const [index, t] of turns.entries()) {
      const turn = index + 1;
      const context = await assembleContext({
        prefix,
        history: store.list(),
        tail: t.tail,
        text: t.text,
        turn,
        via: "text",
      });
      hashes.push(context.prefixHash);
      systems.push(context.system);
      // The tail rides only in the new user message.
      const tailText = renderTail(t.tail);
      expect(context.system).not.toContain(tailText);
      const userContent = String(context.messages.at(-1)?.content);
      expect(userContent).toContain(tailText);
      expect(userContent.endsWith(t.text)).toBe(true);
      for (const earlier of context.messages.slice(0, -1)) {
        if (earlier.role === "user") expect(String(earlier.content)).not.toContain(tailText);
      }
      const [user] = store.append([context.userMessage]);
      const result = await runTurn({
        models: [{ model, provider: "fake", modelId: "fake-model", params: {} }],
        system: context.system,
        messages: context.messages,
        tools: prefix.tools as TurnTool[],
        emit: () => {},
      });
      expect(result.status).toBe("done");
      store.append(messagesFromResponse(turn, "text", result.response));
      expect(user?.seq).toBeGreaterThan(0);
      sent.push(context.messages.map((m) => stableStringify(m)));
    }
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(await prefixHash(prefix));
    expect(new Set(systems).size).toBe(1);
    // Each turn's request starts with the previous turn's request, byte for byte.
    for (let i = 1; i < sent.length; i++) {
      const previous = sent[i - 1] as string[];
      expect((sent[i] as string[]).slice(0, previous.length)).toEqual(previous);
    }
    // The model got the same system message on every request.
    const systemsSent = new Set(
      requests.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "system"))),
    );
    expect(systemsSent.size).toBe(1);
    // And the tool definitions never changed.
    expect(new Set(requests.map((r) => JSON.stringify(r.tools))).size).toBe(1);
  });

  it("changes the prefix hash when the prefix changes", async () => {
    const a = await prefixHash(prefix);
    expect(await prefixHash({ ...prefix, memory: "- Prefers email" })).not.toBe(a);
    expect(await prefixHash({ ...prefix, note: "We were drafting a proposal." })).not.toBe(a);
    expect(await prefixHash({ ...prefix, tools: [] })).not.toBe(a);
    // Key order inside a schema does not matter.
    const reordered: TurnTool = {
      ...lookup,
      inputSchema: { required: ["q"], properties: { q: { type: "string" } }, type: "object" },
    };
    expect(await prefixHash({ ...prefix, tools: [reordered] })).toBe(a);
  });

  it("orders tail blocks and leaves out empty ones", () => {
    expect(
      renderTail([
        { kind: "time", text: "Now: today" },
        { kind: "page", text: "Page: /" },
        { kind: "pending", text: "Also remember: x" },
        { kind: "display", text: "  " },
      ]),
    ).toBe("Also remember: x\n\nPage: /\n\nNow: today");
  });

  it("keeps reasoning only where tool calls need it, and never splits a turn", () => {
    const store = new MemoryMessageStore();
    store.append([
      { turn: 1, role: "user", via: "text", parts: [{ type: "text", text: "one" }] },
      {
        turn: 1,
        role: "assistant",
        via: "text",
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "a" } },
        ],
      },
      {
        turn: 1,
        role: "tool",
        via: "text",
        parts: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "text", value: "x" },
          },
        ],
      },
      {
        turn: 1,
        role: "assistant",
        via: "text",
        parts: [
          { type: "reasoning", text: "more" },
          { type: "text", text: "Answer" },
        ],
      },
      { turn: 2, role: "user", via: "text", parts: [{ type: "text", text: "two".repeat(50) }] },
    ]);
    const all = historyForModel(store.list());
    expect(all).toHaveLength(5);
    expect(JSON.stringify(all[1])).toContain("thinking");
    expect(JSON.stringify(all[3])).not.toContain("more");
    // A budget too small for both turns keeps the newest whole turn.
    const newest = historyForModel(store.list(), 100);
    expect(newest).toHaveLength(1);
    expect(newest[0]?.role).toBe("user");
  });
});
