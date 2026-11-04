// MCP tool definitions → OpenAI-style function tools for chat completions. MCP input schemas are
// JSON Schema objects and so are function `parameters`, but OpenAI's function calling and many
// compatible servers refuse or mishandle anyOf / oneOf / allOf at the top level. Union inputs
// (activity_log's per-type variants) are flattened into one object:
// every property any variant has, required only when every variant requires it, and the exact
// variants appended to the description so the model still sees which combinations are valid.
import type { ToolInfo } from "./mcp.ts";
import type { ChatTool } from "./model.ts";

type JsonSchema = Record<string, unknown>;

const isObject = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Flattens a top-level anyOf/oneOf of object schemas. Returns null when there is none. */
export function flattenTopLevelUnion(
  schema: JsonSchema,
): { schema: JsonSchema; variants: JsonSchema[] } | null {
  const variants = (schema.anyOf ?? schema.oneOf) as unknown;
  if (!Array.isArray(variants) || !variants.every(isObject)) return null;
  const { anyOf: _a, oneOf: _o, allOf: _all, ...rest } = schema;

  const byName = new Map<string, JsonSchema[]>();
  for (const variant of variants) {
    for (const [name, prop] of Object.entries((variant.properties as JsonSchema) ?? {})) {
      const list = byName.get(name) ?? [];
      if (!list.some((p) => JSON.stringify(p) === JSON.stringify(prop)))
        list.push(prop as JsonSchema);
      byName.set(name, list);
    }
  }
  const properties: JsonSchema = { ...((rest.properties as JsonSchema) ?? {}) };
  for (const [name, schemas] of byName) {
    const consts = schemas.map((s) => s.const);
    if (schemas.length > 1 && consts.every((c) => c !== undefined)) {
      const { const: _c, ...base } = schemas[0] as JsonSchema;
      properties[name] = { ...base, enum: consts };
    } else {
      properties[name] = schemas.length === 1 ? schemas[0] : { anyOf: schemas };
    }
  }
  const requiredSets = variants.map((v) => new Set((v.required as string[] | undefined) ?? []));
  const required = [...(requiredSets[0] ?? [])].filter((name) =>
    requiredSets.every((set) => set.has(name)),
  );
  return {
    schema: {
      ...rest,
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    },
    variants,
  };
}

export function toOpenAiTool(tool: ToolInfo): ChatTool {
  const raw: JsonSchema = { ...(tool.inputSchema ?? {}) };
  delete raw.$schema;
  const flattened = flattenTopLevelUnion(raw);
  let description = tool.description ?? "";
  let schema = raw;
  if (flattened) {
    schema = flattened.schema;
    description +=
      `\n\nThe input must match exactly one of these ${flattened.variants.length} shapes ` +
      `(JSON Schema): ${JSON.stringify(flattened.variants)}`;
  }
  return {
    type: "function",
    function: { name: tool.name, description, parameters: { ...schema, type: "object" } },
  };
}

export function toOpenAiTools(tools: ToolInfo[]): ChatTool[] {
  return tools.map(toOpenAiTool);
}
