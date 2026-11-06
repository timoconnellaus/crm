// thread.* operations (ADR 0340): each person's one assistant thread. The thread itself
// (messages, turns, search, unread) lives in their AssistantAgent Durable Object, reached through
// `ctx.assistantThreads`; D1 keeps one bookkeeping row per user (`core_assistant_thread`) and the
// records each thread referenced, for erase. Every operation is scoped to ctx.user. Only
// `thread.search` is open to the assistant itself (to find older messages); the rest are the
// person's, through the UI or their thread object acting for them.
import { sql } from "kysely";
import { z } from "zod";
import { type AssistantContext, assistantContextSchema } from "../assistant/context.ts";
import { conversationRefPattern, MAX_REFS_PER_TURN } from "../assistant/scrub.ts";
import { ConfigError, NotFoundError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

export { type AssistantContext, assistantContextSchema };

export const threadId = z
  .string()
  .regex(/^ath_[0-9A-Za-z]{10,40}$/)
  .describe("An assistant thread id (ath_…)");

const threadSchema = z.object({
  id: z.string(),
  turns: z.number(),
  unread: z.number(),
  preview: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type AssistantThreadSummary = z.infer<typeof threadSchema>;

interface ThreadRow {
  id: string;
  user_id: string;
  turns: number;
  unread: number;
  preview: string | null;
  last_activity_at: string | null;
}

function fromRow(row: ThreadRow): AssistantThreadSummary {
  return {
    id: row.id,
    turns: row.turns,
    unread: row.unread,
    preview: row.preview,
    lastActivityAt: row.last_activity_at,
  };
}

async function loadOwn(ctx: HandlerContext): Promise<ThreadRow | null> {
  const row = (await ctx.db
    .selectFrom("core_assistant_thread")
    .select(["id", "user_id", "turns", "unread", "preview", "last_activity_at"])
    .where("user_id", "=", ctx.user.id)
    .executeTakeFirst()) as ThreadRow | undefined;
  return row ?? null;
}

function threads(ctx: HandlerContext) {
  const store = ctx.assistantThreads;
  if (!store) throw new ConfigError("The assistant is not available on this deployment");
  return store;
}

export const threadOpen = defineOperation({
  name: "thread.open",
  description:
    "Your assistant thread's id, creating its bookkeeping row the first time. Called by the " +
    "thread itself before its first turn.",
  input: z.object({}),
  output: threadSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const existing = await loadOwn(ctx);
    if (existing) return fromRow(existing);
    const row = {
      id: newId("assistantThread"),
      user_id: ctx.user.id,
      turns: 0,
      unread: 0,
      preview: null,
      last_activity_at: null,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_assistant_thread")
        .values(row)
        .onConflict((oc) => oc.column("user_id").doNothing()),
    );
    return fromRow(row);
  },
});

export const threadStatus = defineOperation({
  name: "thread.status",
  description:
    "Your assistant thread at a glance: how many replies you have not seen, and when it was " +
    "last active. Read-only.",
  input: z.object({}),
  output: z.object({
    id: z.string().nullable(),
    unread: z.number(),
    lastActivityAt: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const row = await loadOwn(ctx);
    return {
      id: row?.id ?? null,
      unread: row?.unread ?? 0,
      lastActivityAt: row?.last_activity_at ?? null,
    };
  },
});

export const threadFinishTurn = defineOperation({
  name: "thread.finishTurn",
  description:
    "Record that a turn of your thread finished: its preview, the unread count, and the records " +
    "it referenced (for erase). Called by the thread itself once per turn.",
  input: z.object({
    id: threadId,
    preview: z.string().max(2000).nullable(),
    unread: z.number().int().min(0),
    refs: z
      .array(z.string().regex(conversationRefPattern))
      .max(MAX_REFS_PER_TURN)
      .optional()
      .describe(
        "People and organisations (ids) and emails (email:<sha256>) the turn referenced, for erase",
      ),
  }),
  output: threadSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await loadOwn(ctx);
    if (!row || row.id !== input.id) throw new NotFoundError("thread", input.id);
    const preview = input.preview?.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? null;
    ctx.write(
      ctx.db
        .updateTable("core_assistant_thread")
        .set({
          turns: row.turns + 1,
          unread: input.unread,
          preview,
          last_activity_at: ctx.now,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    // The erase index: one statement in the same batch, whatever the count.
    if (input.refs?.length) {
      ctx.write(
        ctx.db
          .insertInto("core_assistant_thread_refs")
          .orIgnore()
          .columns(["thread_id", "ref"])
          .expression(
            ctx.db
              .selectFrom(sql<{ value: string }>`json_each(${JSON.stringify(input.refs)})`.as("j"))
              .select([sql<string>`${input.id}`.as("thread_id"), "j.value as ref"]),
          ),
      );
    }
    return fromRow({
      ...row,
      turns: row.turns + 1,
      unread: input.unread,
      preview,
      last_activity_at: ctx.now,
    });
  },
});

const searchHit = z.object({
  seq: z.number(),
  turn: z.number(),
  role: z.enum(["user", "assistant", "tool", "notice"]),
  at: z.string(),
  text: z.string(),
});

export const threadSearch = defineOperation({
  name: "thread.search",
  description:
    "Search your whole chat with the assistant, including messages from long ago that are no " +
    "longer in view. Matches every word given (as a word prefix), newest first, and returns each " +
    "message's seq, who wrote it, when, and its words around the match. Read-only.",
  input: z.object({
    query: z.string().trim().min(1).max(200).describe("Words to look for"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ hits: z.array(searchHit) }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "Search this chat" },
  async handler(input, ctx) {
    return { hits: await threads(ctx).search(ctx.user.id, input.query, input.limit) };
  },
});

export const threadDeleteMessage = defineOperation({
  name: "thread.deleteMessage",
  description:
    "Delete a message from your assistant chat: one of yours, or a whole reply (its text, tool " +
    "calls and results). It leaves the chat and its search, and the assistant no longer sees it. " +
    "Changes it made or proposed are not undone.",
  input: z.object({ seq: z.number().int().min(1).describe("The message's seq") }),
  output: z.object({ deleted: z.array(z.number()) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const result = await threads(ctx).deleteMessage(ctx.user.id, input.seq);
    if (!result.deleted.length) throw new NotFoundError("message", String(input.seq));
    return result;
  },
});

export const threadMarkSeen = defineOperation({
  name: "thread.markSeen",
  description:
    "Mark your assistant chat as seen up to a message (the newest when no seq is given), which " +
    "clears the unread badge.",
  input: z.object({ seq: z.number().int().min(0).optional() }),
  output: z.object({ unread: z.number(), lastSeenSeq: z.number() }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const result = await threads(ctx).markSeen(ctx.user.id, input.seq);
    ctx.write(
      ctx.db
        .updateTable("core_assistant_thread")
        .set({ unread: result.unread })
        .where("user_id", "=", ctx.user.id),
    );
    return result;
  },
});

export const assistantOperations = [
  threadOpen,
  threadStatus,
  threadFinishTurn,
  threadSearch,
  threadDeleteMessage,
  threadMarkSeen,
] as const;
