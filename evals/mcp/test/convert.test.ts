import { describe, expect, it } from "vitest";
import { toAnthropicTool, toAnthropicTools } from "../lib/convert.ts";

describe("MCP → Anthropic tool conversion", () => {
  it("keeps name, description and an object input schema", () => {
    const tool = toAnthropicTool({
      name: "person_get",
      description: "Get one person by id. Read-only.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      annotations: { readOnlyHint: true },
    });
    expect(tool).toEqual({
      name: "person_get",
      description: "Get one person by id. Read-only.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });

  it("gives schemas without a type an object type", () => {
    const [tool] = toAnthropicTools([{ name: "approval_status", inputSchema: {} }]);
    expect(tool?.input_schema).toEqual({ type: "object" });
    expect(tool?.description).toBe("");
  });

  it("flattens a top-level union, which the Messages API refuses", () => {
    const variants = [
      {
        type: "object",
        properties: {
          type: { type: "string", const: "note" },
          body: { type: "string" },
          links: { type: "array" },
          reason: { type: "string" },
        },
        required: ["type", "body", "links", "reason"],
      },
      {
        type: "object",
        properties: {
          type: { type: "string", const: "call" },
          payload: { type: "object", properties: { durationSeconds: { type: "number" } } },
          links: { type: "array" },
          reason: { type: "string" },
        },
        required: ["type", "links", "reason"],
      },
    ];
    const tool = toAnthropicTool({
      name: "activity_log",
      description: "Log an activity.",
      inputSchema: { type: "object", anyOf: variants },
    });
    const schema = tool.input_schema as Record<string, unknown>;
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({
      type: { type: "string", enum: ["note", "call"] },
      body: { type: "string" },
      links: { type: "array" },
      reason: { type: "string" },
      payload: { type: "object", properties: { durationSeconds: { type: "number" } } },
    });
    expect(schema.required).toEqual(["type", "links", "reason"]);
    expect(tool.description).toContain("exactly one of these 2 shapes");
    expect(tool.description).toContain('"const":"note"');
  });

  it("keeps differing property schemas as a nested anyOf", () => {
    const tool = toAnthropicTool({
      name: "x",
      inputSchema: {
        oneOf: [
          { type: "object", properties: { payload: { type: "object" } } },
          { type: "object", properties: { payload: { type: "string" } } },
        ],
      },
    });
    expect((tool.input_schema.properties as Record<string, unknown>).payload).toEqual({
      anyOf: [{ type: "object" }, { type: "string" }],
    });
    expect(tool.input_schema.required).toBeUndefined();
  });
});
