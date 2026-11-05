// assistant.* operations (ADR 0030, ADR 0200): the list of a person's in-app assistant
// conversations. The conversation itself (history, streaming, turns) lives in its Durable Object;
// D1 keeps one row per conversation for /assistant. Every operation is scoped to ctx.user, human
// only (the UI and the conversation object acting for its owner) and invisible to MCP.
import { sql } from "kysely";
import { z } from "zod";
import { conversationRefPattern, MAX_REFS_PER_TURN } from "../assistant/scrub.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

export const conversationId = z
  .string()
  .regex(/^asc_[0-9A-Za-z]{10,40}$/)
  .describe("An assistant conversation id (asc_…)");

import { type AssistantContext, assistantContextSchema } from "../assistant/context.ts";

export { type AssistantContext, assistantContextSchema };

const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  context: assistantContextSchema.nullable(),
  turns: z.number(),
  preview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantConversationSummary = z.infer<typeof conversationSchema>;

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  context: string | null;
  turns: number;
  preview: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function parseContext(value: string | null): AssistantContext | null {
  if (!value) return null;
  try {
    const parsed = assistantContextSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fromRow(row: ConversationRow): AssistantConversationSummary {
  return {
    id: row.id,
    title: row.title,
    context: parseContext(row.context),
    turns: row.turns,
    preview: row.preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadOwn(ctx: HandlerContext, id: string): Promise<ConversationRow | null> {
  const row = (await ctx.db
    .selectFrom("core_assistant_conversation")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as ConversationRow | undefined;
  if (!row || row.deleted_at) return null;
  if (row.user_id !== ctx.user.id) {
    throw new ForbiddenError("This conversation belongs to someone else", { id });
  }
  return row;
}

/** A title from the first message: its first line, shortened at a word. */
export function conversationTitle(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!line) return "New conversation";
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const assistantConversations = defineOperation({
  name: "assistant.conversations",
  description:
    "Your in-app assistant conversations, newest first, with their titles, where they started " +
    "and a preview of the last reply. Read-only.",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(30),
    before: z.string().max(40).optional().describe("Only conversations updated before this time"),
  }),
  output: z.object({ conversations: z.array(conversationSchema) }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_assistant_conversation")
      .selectAll()
      .where("user_id", "=", ctx.user.id)
      .where("deleted_at", "is", null);
    if (input.before) query = query.where("updated_at", "<", input.before);
    const rows = (await query
      .orderBy("updated_at", "desc")
      .limit(input.limit)
      .execute()) as ConversationRow[];
    return { conversations: rows.map(fromRow) };
  },
});

export const assistantConversation = defineOperation({
  name: "assistant.conversation",
  description: "One of your assistant conversations, or not_found. Read-only.",
  input: z.object({ id: conversationId }),
  output: conversationSchema,
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadOwn(ctx, input.id);
    if (!row) throw new NotFoundError("conversation", input.id);
    return fromRow(row);
  },
});

export const assistantStartConversation = defineOperation({
  name: "assistant.startConversation",
  description:
    "Start an assistant conversation: returns its id. The title comes from the first message.",
  input: z.object({
    text: z.string().max(20_000).describe("The first message (for the title)"),
    context: assistantContextSchema.optional(),
  }),
  output: conversationSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row: ConversationRow = {
      id: newId("assistantConversation"),
      user_id: ctx.user.id,
      title: conversationTitle(input.text),
      context: input.context ? JSON.stringify(input.context) : null,
      turns: 0,
      preview: null,
      created_at: ctx.now,
      updated_at: ctx.now,
      deleted_at: null,
    };
    ctx.write(ctx.db.insertInto("core_assistant_conversation").values(row));
    return fromRow(row);
  },
});

export const assistantFinishTurn = defineOperation({
  name: "assistant.finishTurn",
  description:
    "Record that a turn of your conversation finished (the list's preview and turn count). " +
    "Called by the conversation itself once per turn.",
  input: z.object({
    id: conversationId,
    preview: z.string().max(2000).nullable(),
    refs: z
      .array(z.string().regex(conversationRefPattern))
      .max(MAX_REFS_PER_TURN)
      .optional()
      .describe(
        "People and organisations (ids) and emails (email:<sha256>) the turn referenced, for erase",
      ),
  }),
  output: conversationSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadOwn(ctx, input.id);
    if (!row) throw new NotFoundError("conversation", input.id);
    const preview = input.preview?.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? null;
    ctx.write(
      ctx.db
        .updateTable("core_assistant_conversation")
        .set({ turns: row.turns + 1, preview, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    // The erase index (migration 0270): one statement in the same batch, whatever the count.
    if (input.refs?.length) {
      ctx.write(
        ctx.db
          .insertInto("core_assistant_conversation_refs")
          .orIgnore()
          .columns(["conversation_id", "ref"])
          .expression(
            ctx.db
              .selectFrom(sql<{ value: string }>`json_each(${JSON.stringify(input.refs)})`.as("j"))
              .select([sql<string>`${input.id}`.as("conversation_id"), "j.value as ref"]),
          ),
      );
    }
    return fromRow({ ...row, turns: row.turns + 1, preview, updated_at: ctx.now });
  },
});

export const assistantDeleteConversation = defineOperation({
  name: "assistant.deleteConversation",
  description:
    "Delete one of your assistant conversations: it leaves the list and its history is " +
    "erased. Pending changes it proposed stay in the Approvals inbox.",
  input: z.object({ id: conversationId }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadOwn(ctx, input.id);
    if (!row) throw new NotFoundError("conversation", input.id);
    ctx.write(
      ctx.db
        .updateTable("core_assistant_conversation")
        .set({ deleted_at: ctx.now, title: "(deleted)", preview: null, context: null })
        .where("id", "=", input.id),
      ctx.db.deleteFrom("core_assistant_conversation_refs").where("conversation_id", "=", input.id),
    );
    return { id: input.id, deleted: true as const };
  },
});

export const assistantOperations = [
  assistantConversations,
  assistantConversation,
  assistantStartConversation,
  assistantFinishTurn,
  assistantDeleteConversation,
] as const;
