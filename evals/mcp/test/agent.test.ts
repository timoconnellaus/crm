import { describe, expect, it } from "vitest";
import { parseArguments, runAgent } from "../lib/agent.ts";
import type { ChatTool } from "../lib/model.ts";
import { fakeSession, reply, scriptedModel, toolCall } from "./fakes.ts";

const tools: ChatTool[] = [
  {
    type: "function",
    function: { name: "search_global", description: "", parameters: { type: "object" } },
  },
];

describe("runAgent", () => {
  it("runs tool calls through MCP, records them, and feeds results back", async () => {
    const search = toolCall("search_global", { query: "ada" });
    const create = toolCall("person_create", { givenName: "Ada", reason: "New lead" });
    const { model, requests } = scriptedModel([
      reply("Let me check first.", [search]),
      reply(null, [create]),
      reply("Created Ada."),
    ]);
    const mcp = fakeSession({
      search_global: () => ({ hits: [] }),
      person_create: () => ({ id: "per_1" }),
    });
    const run = await runAgent({
      model,
      executor: mcp,
      modelId: "@cf/test/model",
      system: "sys",
      tools,
      prompts: ["Add Ada"],
      maxTurns: 10,
      temperature: 0.2,
      maxTokens: 4000,
      reasoningEffort: "high",
    });

    expect(run.calls.map((c) => [c.name, c.input, c.result])).toEqual([
      ["search_global", { query: "ada" }, { hits: [] }],
      ["person_create", { givenName: "Ada", reason: "New lead" }, { id: "per_1" }],
    ]);
    expect(run.turns).toBe(3);
    expect(run.stopReason).toBe("stop");
    expect(run.finalText).toBe("Let me check first.\n\nCreated Ada.");
    expect(run.error).toBeUndefined();
    expect(run.usage).toEqual({ inputTokens: 30, outputTokens: 15 });

    const first = requests[0];
    expect(first?.model).toBe("@cf/test/model");
    expect(first?.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(first?.tools).toBe(tools);
    expect(first?.temperature).toBe(0.2);
    expect(first?.max_tokens).toBe(4000);
    expect(first?.reasoning_effort).toBe("high");
    // Append-only: the assistant message goes back as it came, then one tool message per call.
    const second = requests[1]?.messages ?? [];
    expect(second).toHaveLength(4);
    expect(second[2]).toEqual({
      role: "assistant",
      content: "Let me check first.",
      tool_calls: [search],
    });
    expect(second[3]).toEqual({ role: "tool", tool_call_id: search.id, content: '{"hits":[]}' });
  });

  it("returns every parallel result as its own tool message and marks errors", async () => {
    const a = toolCall("person_get", { id: "per_1" });
    const b = toolCall("person_get", { id: "per_missing" });
    const { model, requests } = scriptedModel([reply(null, [a, b]), reply("One is missing.")]);
    const mcp = fakeSession({
      person_get: (args) =>
        args.id === "per_1" ? { id: "per_1" } : { isError: true, error: { code: "not_found" } },
    });
    const run = await runAgent({
      model,
      executor: mcp,
      modelId: "m",
      system: "",
      tools,
      prompts: ["x"],
      maxTurns: 5,
    });
    expect(run.calls.map((c) => c.isError)).toEqual([false, true]);
    const messages = requests[1]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(messages[3]).toMatchObject({ tool_call_id: b.id });
    expect(requests[0]?.temperature).toBeUndefined();
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  });

  it("runs tool calls even when the server says finish_reason stop", async () => {
    const { model } = scriptedModel([
      reply(null, [toolCall("search_global", {})], "stop"),
      reply("Nothing found."),
    ]);
    const run = await runAgent({
      model,
      executor: fakeSession({ search_global: () => ({ hits: [] }) }),
      modelId: "m",
      system: "",
      tools,
      prompts: ["x"],
      maxTurns: 5,
    });
    expect(run.calls).toHaveLength(1);
    expect(run.finalText).toBe("Nothing found.");
  });

  it("answers malformed arguments with an error instead of calling the tool", async () => {
    const bad = {
      id: "call_bad",
      type: "function" as const,
      function: { name: "search_global", arguments: '{"query": ' },
    };
    const mcp = fakeSession({ search_global: () => ({ hits: [] }) });
    const { model, requests } = scriptedModel([reply(null, [bad]), reply("Sorry.")]);
    const run = await runAgent({
      model,
      executor: mcp,
      modelId: "m",
      system: "",
      tools,
      prompts: ["x"],
      maxTurns: 5,
    });
    expect(mcp.calls).toEqual([]);
    expect(run.calls[0]?.isError).toBe(true);
    expect(String(requests[1]?.messages.at(-1)?.content)).toContain("not valid JSON");
  });

  it("turns a thrown tool call into an error result instead of stopping", async () => {
    const { model } = scriptedModel([reply(null, [toolCall("boom", {})]), reply("It failed.")]);
    const run = await runAgent({
      model,
      executor: {
        callTool: async () => {
          throw new Error("connection reset");
        },
      },
      modelId: "m",
      system: "",
      tools,
      prompts: ["x"],
      maxTurns: 5,
    });
    expect(run.calls[0]?.isError).toBe(true);
    expect(run.calls[0]?.resultText).toContain("connection reset");
    expect(run.finalText).toBe("It failed.");
  });

  it("continues the same conversation across several prompts", async () => {
    const { model, requests } = scriptedModel([
      reply("Queued for approval."),
      reply(null, [toolCall("approval_status", {})]),
      reply("Still pending."),
    ]);
    const mcp = fakeSession({ approval_status: () => ({ changeSets: [] }) });
    const run = await runAgent({
      model,
      executor: mcp,
      modelId: "m",
      system: "",
      tools,
      prompts: ["Delete it", "Done yet?"],
      maxTurns: 5,
    });
    expect(run.replies).toEqual(["Queued for approval.", "Still pending."]);
    expect(run.calls[0]?.promptIndex).toBe(1);
    expect(requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("stops at maxTurns and on unexpected finish reasons", async () => {
    const looping = scriptedModel([
      reply(null, [toolCall("search_global", {})]),
      reply(null, [toolCall("search_global", {})]),
    ]);
    const mcp = fakeSession({ search_global: () => ({ hits: [] }) });
    const capped = await runAgent({
      model: looping.model,
      executor: mcp,
      modelId: "m",
      system: "",
      tools,
      prompts: ["x", "never sent"],
      maxTurns: 2,
    });
    expect(capped.error).toBe("Stopped after 2 model turns without finishing");
    expect(capped.replies).toHaveLength(1);

    const cut = scriptedModel([reply("Half a", [], "length")]);
    const run = await runAgent({
      model: cut.model,
      executor: mcp,
      modelId: "m",
      system: "",
      tools,
      prompts: ["x"],
      maxTurns: 2,
    });
    expect(run.error).toBe("The model stopped with length");
  });
});

describe("parseArguments", () => {
  it("accepts objects and empty strings, refuses the rest", () => {
    expect(parseArguments('{"a":1}')).toEqual({ input: { a: 1 } });
    expect(parseArguments("")).toEqual({ input: {} });
    expect(parseArguments("[1]")).toEqual({ error: "the tool arguments must be a JSON object" });
    expect(parseArguments("{")).toHaveProperty("error");
  });
});
