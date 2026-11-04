// MCP tools generated from the operations registry (ADR 0021): curated operations become their
// own tools, everything else MCP may reach goes through describe_operations / call_operation,
// and operations marked `mcp: { expose: false }` are invisible and uncallable. Every reviewable
// (non-read) call takes a required `reason`, stored on the pending action when it is queued.
import {
  type AnyOperation,
  CORE_OBJECTS,
  coreRegistry,
  type FieldDefinition,
  type InvocationContext,
  invokeByName,
  OperationError,
  PendingApprovalError,
  type Permission,
  RateLimitedError,
  roleHasPermission,
  toOperationError,
  UnknownOperationError,
  ValidationError,
} from "@crm/core";
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

export const SERVER_NAME = "crm";
export const SCHEMA_RESOURCE_URI = "crm://schema";

export const SERVER_INSTRUCTIONS = `This server is a CRM: people, organisations, their activities (notes, emails, calls, meetings) and tasks.

- Search before you create. Use search_global (or person_get / organisation_get) to find a record first; emails and domains are unique, so creating a duplicate fails with a conflict.
- Always give a reason. Every tool that changes data takes a required "reason": one sentence a person reviewing the change will read. Make it specific ("Logged the call Ada described in her email of 3 Nov").
- Some changes need approval. Depending on the org's approval policy, a write may come back as {"status": "pending_approval", ...} instead of applying. It is NOT done: it waits in a change set for a person to approve it in the CRM's Approvals inbox. Say so plainly to the user. Until it is decided, your own reads in this session show it as if applied, and a created record has a provisional id (per_pending_…) you can link activities and tasks to. Check progress with approval_status; once applied, its bindings give the real ids.
- Group a task with changeset_begin (give it a title) and changeset_commit when done, so the reviewer sees one coherent change set.
- Analysis: query_sql runs read-only SQL (one SELECT or WITH) over the crm_* views (crm_people, crm_organisations, crm_affiliations, crm_activities, crm_activity_links, crm_tasks, crm_task_links, crm_record_tags, crm_users). Read the crm://schema resource for objects, fields and operations.
- The curated tools cover common work. For anything else, describe_operations lists every operation you may call with its input schema, and call_operation runs one by name.`;

/** MCP tool names allow letters, digits, `_` and `-`: `person.create` → `person_create`. */
export function toolName(operation: string): string {
  return operation.replace(/\./g, "_");
}

/** Operations MCP can see at all. */
export function mcpOperations(): AnyOperation[] {
  return coreRegistry.list().filter((op) => op.mcp?.expose !== false);
}

export function mcpOperation(name: string): AnyOperation | undefined {
  const op = coreRegistry.get(name);
  return op && op.mcp?.expose !== false ? op : undefined;
}

export function requiresReason(op: AnyOperation): boolean {
  return op.risk !== "read" && !op.bookkeeping;
}

const REASON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 1000,
  description:
    "Why you are making this change, in one sentence for the person who may review it. Required.",
};

type JsonSchema = Record<string, unknown>;

/** The operation's input as JSON Schema, plus a required `reason` for reviewable operations. */
export function toolInputSchema(op: AnyOperation): JsonSchema {
  const schema = z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as JsonSchema;
  delete schema.$schema;
  if (!requiresReason(op)) return schema.type === "object" ? schema : { type: "object", ...schema };
  const withReason = (s: JsonSchema): JsonSchema => ({
    ...s,
    type: "object",
    properties: { ...((s.properties as JsonSchema) ?? {}), reason: REASON_SCHEMA },
    required: [...new Set([...((s.required as string[]) ?? []), "reason"])],
  });
  if (schema.type === "object") return withReason(schema);
  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (variants) {
    const { anyOf: _a, oneOf: _o, ...rest } = schema;
    return { ...rest, type: "object", anyOf: variants.map(withReason) };
  }
  return withReason({ type: "object" });
}

/**
 * A Standard Schema the MCP SDK can advertise and "validate". It passes any object through:
 * the pipeline validates against the operation's zod schema and returns typed errors, which
 * read better to a model than SDK-level schema failures.
 */
type Args = Record<string, unknown>;

function passthroughSchema(json: JsonSchema): StandardSchemaWithJSON<Args, Args> {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "crm",
      validate: (value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? { value: value as Args }
          : { issues: [{ message: "Expected an object of arguments" }] },
      jsonSchema: { input: () => json, output: () => json },
      types: undefined as unknown as { input: Args; output: Args },
    },
  };
}

export interface McpCaller {
  /** The invocation context for this request (actor mcp, user, origin, scopes). */
  context: InvocationContext;
  /** Counts one write against the per-token limit; throws RateLimitedError when over. */
  consumeWrite(): Promise<void>;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function text(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Runs one operation for an MCP caller and shapes the result, pending result or error. */
export async function callForMcp(
  caller: McpCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const op = mcpOperation(name);
    if (!op) throw new UnknownOperationError(name);
    const { reason, ...input } = args;
    if (requiresReason(op) && (typeof reason !== "string" || !reason.trim())) {
      throw new ValidationError(
        `${op.name} changes data, so it needs a "reason": one sentence for the person who may review it`,
        { field: "reason" },
      );
    }
    if (op.risk !== "read") await caller.consumeWrite();
    const output = await invokeByName(op.name, input, {
      ...caller.context,
      reason: typeof reason === "string" ? reason.trim().slice(0, 1000) : undefined,
    });
    return text(output ?? null);
  } catch (error) {
    if (error instanceof PendingApprovalError) return text(error.pending);
    const typed = toOperationError(error);
    if (typed.code === "internal" || typed.code === "config") {
      console.error(`mcp ${name} failed`, error);
      return text({ error: { code: typed.code, message: typed.message } }, true);
    }
    return text({ error: typed.toJSON() }, true);
  }
}

function allowedFor(op: AnyOperation, context: InvocationContext): boolean {
  if (op.actors && !op.actors.includes(context.actor)) return false;
  if (!roleHasPermission(context.user.role, op.permission)) return false;
  return !context.grantedPermissions || context.grantedPermissions.includes(op.permission);
}

/** The crm://schema resource: objects and fields, operations and their risk classes. */
export function schemaDocument(context?: InvocationContext) {
  return {
    objects: Object.values(CORE_OBJECTS).map((o) => ({
      name: o.name,
      label: o.label,
      view: o.source,
      fields: (o.fields as readonly FieldDefinition[]).map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        ...(f.enumValues ? { values: f.enumValues } : {}),
        filterable: f.filterable,
        sortable: f.sortable,
        ...(f.track ? { track: f.track } : {}),
      })),
    })),
    operations: mcpOperations().map((op) => ({
      name: op.name,
      tool: op.mcp?.curated ? toolName(op.name) : null,
      risk: op.risk,
      permission: op.permission as Permission,
      requiresReason: requiresReason(op),
      ...(context ? { allowed: allowedFor(op, context) } : {}),
    })),
    riskClasses: {
      read: "never changes anything",
      write: "changes one record",
      "bulk-write": "changes many records in one call",
      destructive: "deletes or merges records",
    },
  };
}

const describeInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Words to match in operation names and descriptions, e.g. 'merge' or 'tag'"),
  object: z.string().max(64).optional().describe("Only operations on this object, e.g. 'person'"),
  names: z.array(z.string().max(100)).max(50).optional().describe("Exact operation names"),
  includeSchemas: z
    .boolean()
    .default(true)
    .describe("Include each operation's JSON input schema (default true)"),
});

const callInput = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("Operation name from describe_operations, e.g. person.merge"),
  input: z.record(z.string(), z.unknown()).default({}).describe("The operation's input"),
  reason: z
    .string()
    .max(1000)
    .optional()
    .describe("Required for operations that change data: why, in one sentence for the reviewer"),
});

/** Builds the MCP server for one request. */
export function createCrmMcpServer(caller: McpCaller, version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "CRM", version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const op of mcpOperations().filter((o) => o.mcp?.curated)) {
    const reviewable = requiresReason(op);
    server.registerTool(
      toolName(op.name),
      {
        title: op.mcp?.title ?? op.name,
        description:
          op.description +
          (reviewable
            ? " Requires a reason. Depending on the approval policy it may be queued for approval instead of applied: check for status 'pending_approval'."
            : ""),
        inputSchema: passthroughSchema(toolInputSchema(op)),
        annotations: {
          readOnlyHint: op.risk === "read",
          destructiveHint: op.risk === "destructive" || op.risk === "bulk-write",
          idempotentHint: op.risk === "read" || Boolean(op.mcp?.idempotent),
          openWorldHint: false,
        },
      },
      async (args) => callForMcp(caller, op.name, args),
    );
  }

  server.registerTool(
    "describe_operations",
    {
      title: "Describe operations",
      description:
        "List the CRM operations you can call with call_operation, with their descriptions, " +
        "risk classes, whether they need a reason, whether your role and this connection's " +
        "scopes allow them, and their JSON input schemas. Filter with query, object or names. " +
        "Read-only.",
      inputSchema: describeInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const ops = mcpOperations().filter((op) => {
        if (args.names && !args.names.includes(op.name)) return false;
        if (args.object && !op.name.startsWith(`${args.object}.`)) return false;
        const hay = `${op.name} ${op.description}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      return text({
        operations: ops.map((op) => ({
          name: op.name,
          tool: op.mcp?.curated ? toolName(op.name) : null,
          description: op.description,
          risk: op.risk,
          permission: op.permission,
          requiresReason: requiresReason(op),
          allowed: allowedFor(op, caller.context),
          ...(args.includeSchemas
            ? { inputSchema: z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) }
            : {}),
        })),
      });
    },
  );

  server.registerTool(
    "call_operation",
    {
      title: "Call an operation",
      description:
        "Run any CRM operation listed by describe_operations, by name, with its input. It goes " +
        "through the same permissions, approval policy and audit as the dedicated tools. " +
        "Operations that change data need a reason, and may come back as 'pending_approval' " +
        "instead of applying.",
      inputSchema: callInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      callForMcp(caller, args.name, {
        ...(args.input ?? {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }),
  );

  server.registerResource(
    "schema",
    SCHEMA_RESOURCE_URI,
    {
      title: "CRM schema",
      description:
        "Objects and their fields, and the operations you can call with their risk classes.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(schemaDocument(caller.context), null, 2),
        },
      ],
    }),
  );

  return server;
}

export { OperationError, RateLimitedError };
