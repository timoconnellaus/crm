import { describe, expect, it } from "vitest";
import { toOpenAiTool, toOpenAiTools } from "../lib/convert.ts";

describe("MCP → OpenAI function tool conversion", () => {
  it("keeps name, description and an object parameters schema", () => {
    const tool = toOpenAiTool({
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
      type: "function",
      function: {
        name: "person_get",
        description: "Get one person by id. Read-only.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    });
  });

  it("gives schemas without a type an object type", () => {
    const [tool] = toOpenAiTools([{ name: "approval_status", inputSchema: {} }]);
    expect(tool?.function.parameters).toEqual({ type: "object" });
    expect(tool?.function.description).toBe("");
  });

  it("flattens a top-level union, which function calling refuses", () => {
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
    const tool = toOpenAiTool({
      name: "activity_log",
      description: "Log an activity.",
      inputSchema: { type: "object", anyOf: variants },
    });
    const schema = tool.function.parameters;
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
    expect(tool.function.description).toContain("exactly one of these 2 shapes");
    expect(tool.function.description).toContain('"const":"note"');
  });

  it("keeps differing property schemas as a nested anyOf", () => {
    const tool = toOpenAiTool({
      name: "x",
      inputSchema: {
        oneOf: [
          { type: "object", properties: { payload: { type: "object" } } },
          { type: "object", properties: { payload: { type: "string" } } },
        ],
      },
    });
    expect((tool.function.parameters.properties as Record<string, unknown>).payload).toEqual({
      anyOf: [{ type: "object" }, { type: "string" }],
    });
    expect(tool.function.parameters.required).toBeUndefined();
  });
});
