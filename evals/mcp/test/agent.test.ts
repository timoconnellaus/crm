import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runAgent } from "../lib/agent.ts";
import { fakeSession, message, scriptedModel, text, toolUse } from "./fakes.ts";

const tools: Anthropic.Tool[] = [{ name: "search_global", input_schema: { type: "object" } }];

describe("runAgent", () => {
  it("runs tool calls through MCP, records them, and feeds results back", async () => {
    const search = toolUse("search_global", { query: "ada" });
    const create = toolUse("person_create", { givenName: "Ada", reason: "New lead" });
    const { model, requests } = scriptedModel([
      message([text("Let me check first."), search]),
      message([create]),
      message([text("Created Ada.")]),
    ]);
    const mcp = fakeSession({
      search_global: () => ({ hits: [] }),
      person_create: () => ({ id: "per_1" }),
    });
    const run = await runAgent({
      model,
      executor: mcp,
      modelId: "claude-opus-5-5",
      system: "sys",
      tools,
      prompts: ["Add Ada"],
      maxTurns: 10,
      effort: "high",
    });

    expect(run.calls.map((c) => [c.name, c.input, c.result])).toEqual([
      ["search_global", { query: "ada" }, { hits: [] }],
      ["person_create", { givenName: "Ada", reason: "New lead" }, { id: "per_1" }],
    ]);
    expect(run.turns).toBe(3);
    expect(run.stopReason).toBe("end_turn");
    expect(run.finalText).toBe("Let me check first.\n\nCreated Ada.");
    expect(run.error).toBeUndefined();
    expect(run.usage).toEqual({ inputTokens: 30, outputTokens: 15 });

    const first = requests[0];
    expect(first?.model).toBe("claude-opus-5-5");
    expect(first?.system).toBe("sys");
    expect(first?.tools).toBe(tools);
    expect(first?.output_config).toEqual({ effort: "high" });
    // Append-only: the assistant turn goes back as it came, then one user message of results.
    const second = requests[1]?.messages ?? [];
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: "assistant",
      content: [text("Let me check first."), search],
    });
    expect(second[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: (search as { id: string }).id, content: '{"hits":[]}' },
      ],
    });
  });

  it("returns every parallel result in one user message and marks errors", async () => {
    const a = toolUse("person_get", { id: "per_1" });
    const b = toolUse("person_get", { id: "per_missing" });
    const { model, requests } = scriptedModel([
      message([a, b]),
      message([text("One is missing.")]),
    ]);
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
    const results = requests[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
    expect(results).toHaveLength(2);
    expect(results[1]?.is_error).toBe(true);
    expect(requests[0]?.output_config).toBeUndefined();
  });

  it("turns a thrown tool call into an error result instead of stopping", async () => {
    const { model } = scriptedModel([
      message([toolUse("boom", {})]),
      message([text("It failed.")]),
    ]);
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
      message([text("Queued for approval.")]),
      message([toolUse("approval_status", {})]),
      message([text("Still pending.")]),
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

  it("stops at maxTurns and on unexpected stop reasons", async () => {
    const looping = scriptedModel([
      message([toolUse("search_global", {})]),
      message([toolUse("search_global", {})]),
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

    const refused = scriptedModel([message([], "refusal")]);
    const run = await runAgent({
      model: refused.model,
      executor: mcp,
      modelId: "m",
      system: "",
      tools,
      prompts: ["x"],
      maxTurns: 2,
    });
    expect(run.error).toBe("The model stopped with refusal");
  });
});
