// EVAL_VIA=assistant (stage 7 AC 5): runAgent drives the deployment's in-app assistant and
// records its streamed tool calls in the same shape as an MCP run, so grading is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../lib/agent.ts";
import {
  configureVia,
  parseEvents,
  runViaAssistant,
  setAssistantDriver,
} from "../lib/assistant.ts";

const sse = (events: unknown[]) =>
  events.map((e, i) => `id: ${i + 1}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function fakeFetch() {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body, headers: new Headers(init?.headers) });
    const turn = requests.length;
    return new Response(
      sse([
        { seq: 1, type: "turn-start", turn, text: body.text },
        { seq: 2, type: "step", model: "fake" },
        {
          seq: 3,
          type: "tool-call",
          id: `c${turn}`,
          tool: "person_create",
          input: { displayName: "Ada" },
        },
        {
          seq: 4,
          type: "tool-result",
          id: `c${turn}`,
          tool: "person_create",
          output: { id: "per_1", displayName: "Ada" },
          isError: false,
        },
        { seq: 5, type: "text", delta: `Created Ada (${turn}).` },
        { seq: 6, type: "turn-end", status: "done" },
      ]),
      { headers: { "x-thread-id": "ath_01TESTTHREAD000000" } },
    );
  }) as typeof fetch;
  return { requests, fn };
}

afterEach(() => setAssistantDriver(null));

describe("running eval tasks through the in-app assistant", () => {
  it("is off unless EVAL_VIA=assistant", () => {
    expect(configureVia("http://localhost:5173", "c=1", {})).toBe(false);
    expect(configureVia("http://localhost:5173", "c=1", { EVAL_VIA: "assistant" })).toBe(true);
  });

  it("records the assistant's tool calls and replies, in the one thread", async () => {
    const { requests, fn } = fakeFetch();
    const run = await runViaAssistant(
      { baseUrl: "http://localhost:5173", cookie: "session=abc", fetch: fn },
      ["Add Ada", "And again"],
    );
    expect(run.calls).toEqual([
      expect.objectContaining({ promptIndex: 0, name: "person_create", isError: false }),
      expect.objectContaining({ promptIndex: 1, name: "person_create" }),
    ]);
    expect(run.calls[0]?.result).toEqual({ id: "per_1", displayName: "Ada" });
    expect(run.replies).toEqual(["Created Ada (1).", "Created Ada (2)."]);
    expect(run.stopReason).toBe("done");
    expect(requests[0]?.headers.get("cookie")).toBe("session=abc");
    // One thread per user: no conversation id to carry between prompts.
    expect(requests[1]?.body).toEqual({ text: "And again" });
  });

  it("is what runAgent uses once configured", async () => {
    const { fn } = fakeFetch();
    setAssistantDriver({ baseUrl: "http://localhost:5173", cookie: "s", fetch: fn });
    const run = await runAgent({
      model: { complete: async () => Promise.reject(new Error("must not be called")) } as never,
      executor: { callTool: async () => Promise.reject(new Error("must not be called")) },
      modelId: "unused",
      system: "",
      tools: [],
      prompts: ["Add Ada"],
      maxTurns: 5,
    });
    expect(run.finalText).toBe("Created Ada (1).");
  });

  it("parses server-sent events", () => {
    expect(parseEvents('id: 1\ndata: {"seq":1,"type":"text","delta":"hi"}\n\n')).toEqual([
      { seq: 1, type: "text", delta: "hi" },
    ]);
  });
});
