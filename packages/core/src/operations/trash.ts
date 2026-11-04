// trash.* operations: what is in Trash (soft-deleted people, organisations, activities and tasks)
// and the scheduled purge that hard-deletes them once their 30-day restore window has passed.
import { type SqlBool, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { decodeCursor, encodeCursor } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { chunk, purgeCutoff, restorableUntil, TRASH_RETENTION_DAYS } from "../records/common.ts";

/**
 * Everything in Trash: what trash.list shows, the UI can restore, and trash.purge hard-deletes
 * after the retention window (people, organisations, activities, tasks).
 */
const TRASH_LIST_OBJECTS = ["person", "organisation", "activity", "task"] as const;
type TrashListObject = (typeof TRASH_LIST_OBJECTS)[number];

const trashItemSchema = z.object({
  object: z.enum(TRASH_LIST_OBJECTS),
  id: z.string(),
  name: z.string().describe("Display name, task title, or activity subject (or body excerpt)"),
  deletedAt: z.string(),
  deletedBy: z.string().nullable(),
  restorableUntil: z.string().describe("After this the scheduled purge deletes it for good"),
  mergedIntoId: z.string().nullable().describe("Set when it was merged away into this record"),
});

const TRASH_SORT = { field: "deletedAt", direction: "desc" } as const;

export const trashList = defineOperation({
  name: "trash.list",
  description:
    "List what is in Trash: soft-deleted people, organisations, activities and tasks, most " +
    "recently deleted first, each with when it was deleted and the date it stays restorable " +
    `until (${TRASH_RETENTION_DAYS} days). Merged-away records show the record they were ` +
    "merged into. Restore with person.restore, organisation.restore, activity.restore or " +
    "task.restore. Pass nextCursor back as cursor for the next page. Read-only.",
  input: z.object({
    object: z.enum(TRASH_LIST_OBJECTS).optional().describe("Only this kind of record"),
    cursor: z.string().max(1000).optional().describe("nextCursor from the previous page."),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ items: z.array(trashItemSchema), nextCursor: z.string().nullable() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const sources = {
      person: () =>
        ctx.db
          .selectFrom("core_person")
          .select([
            sql<TrashListObject>`'person'`.as("object"),
            "id",
            sql<string>`display_name`.as("name"),
            "deleted_at",
            "deleted_by",
            "merged_into_id",
          ])
          .where("deleted_at", "is not", null),
      organisation: () =>
        ctx.db
          .selectFrom("core_organisation")
          .select([
            sql<TrashListObject>`'organisation'`.as("object"),
            "id",
            sql<string>`name`.as("name"),
            "deleted_at",
            "deleted_by",
            "merged_into_id",
          ])
          .where("deleted_at", "is not", null),
      activity: () =>
        ctx.db
          .selectFrom("core_activity")
          .select([
            sql<TrashListObject>`'activity'`.as("object"),
            "id",
            sql<string>`coalesce(nullif(trim(subject), ''), substr(body, 1, 120), type)`.as("name"),
            "deleted_at",
            "deleted_by",
            sql<string | null>`null`.as("merged_into_id"),
          ])
          .where("deleted_at", "is not", null),
      task: () =>
        ctx.db
          .selectFrom("core_task")
          .select([
            sql<TrashListObject>`'task'`.as("object"),
            "id",
            sql<string>`title`.as("name"),
            "deleted_at",
            "deleted_by",
            sql<string | null>`null`.as("merged_into_id"),
          ])
          .where("deleted_at", "is not", null),
    };
    const [first, ...rest] = (input.object ? [input.object] : TRASH_LIST_OBJECTS).map((object) =>
      sources[object](),
    );
    if (!first) return { items: [], nextCursor: null };
    // Every branch selects the same columns in the same order, so the union has the first's rows.
    const source = rest.reduce<typeof first>(
      (union, next) => union.unionAll(next as unknown as typeof first),
      first,
    );

    let query = ctx.db.selectFrom(source.as("t")).selectAll();
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, TRASH_SORT);
      query = query.where(
        sql<SqlBool>`(t.deleted_at < ${cursor.v} OR (t.deleted_at = ${cursor.v} AND t.id < ${cursor.id}))`,
      );
    }
    const rows = await query
      .orderBy("t.deleted_at", "desc")
      .orderBy("t.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const deletedAt = row.deleted_at ?? "";
        return {
          object: row.object,
          id: row.id,
          name: row.name,
          deletedAt,
          deletedBy: row.deleted_by,
          restorableUntil: restorableUntil(deletedAt),
          mergedIntoId: row.merged_into_id,
        };
      }),
      nextCursor:
        rows.length > input.limit && last?.deleted_at
          ? encodeCursor({ f: "deletedAt", d: "desc", v: last.deleted_at, id: last.id })
          : null,
    };
  },
});

export const PURGE_MAX = 100;

/** The table behind each kind of record trash.purge hard-deletes. */
const PURGE_TABLES = {
  person: "core_person",
  organisation: "core_organisation",
  task: "core_task",
  activity: "core_activity",
} as const satisfies Record<TrashListObject, string>;

export const trashPurge = defineOperation({
  name: "trash.purge",
  description:
    `Permanently delete everything that has been in Trash for more than ` +
    `${TRASH_RETENTION_DAYS} days (oldest first, at most limit per call): people and ` +
    "organisations with their emails, phones, domains, addresses, affiliations, tags and links, " +
    "and deleted activities and tasks with their links and search entries. Live activities and " +
    "tasks linked to a purged record are kept (they lose only that link). Run by the scheduled " +
    "purge as an automation; it never touches records still within their restore window. " +
    "Returns what was purged and whether more is due.",
  input: z.object({
    limit: z.number().int().min(1).max(PURGE_MAX).default(50),
  }),
  output: z.object({
    cutoff: z.string().describe("Records deleted before this were due"),
    purged: z.array(
      z.object({ object: z.enum(TRASH_LIST_OBJECTS), id: z.string(), deletedAt: z.string() }),
    ),
    more: z.boolean().describe("True when more records are due; call again"),
  }),
  permission: "records:erase",
  // The destructive decision was the delete, which was gated then and promised this purge
  // (restorableUntil). Carrying out that retention is a system write (ADR 0018 amendment).
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => ({
    count: output.purged.length,
    cutoff: output.cutoff,
    more: output.more,
  }),
  async handler(input, ctx) {
    const cutoff = purgeCutoff(ctx.now);
    if (!(cutoff < ctx.now)) throw new ValidationError("Invalid clock");
    const due = (object: TrashListObject, limit: number) =>
      limit <= 0
        ? Promise.resolve([])
        : ctx.db
            .selectFrom(PURGE_TABLES[object])
            .select(["id", "deleted_at"])
            .where("deleted_at", "is not", null)
            .where("deleted_at", "<", cutoff)
            .orderBy("deleted_at")
            .orderBy("id")
            .limit(limit)
            .execute();

    // Ask for one more than the limit to learn whether another call is needed. People first:
    // their affiliations cascade before the organisations go. Tasks before activities: deleting
    // a task drops the activity links that point at it.
    const purged: { object: TrashListObject; id: string; deletedAt: string }[] = [];
    let more = false;
    for (const object of ["person", "organisation", "task", "activity"] as const) {
      const rows = await due(object, input.limit + 1 - purged.length);
      const room = input.limit - purged.length;
      if (rows.length > room) more = true;
      for (const row of rows.slice(0, Math.max(room, 0))) {
        purged.push({ object, id: row.id, deletedAt: row.deleted_at ?? "" });
      }
      if (more) break;
    }

    // Links, tags and search entries go by cascade and trigger (migrations 0003, 0004, 0006).
    for (const object of ["person", "organisation", "task", "activity"] as const) {
      const ids = purged.filter((r) => r.object === object).map((r) => r.id);
      for (const part of chunk(ids)) {
        ctx.write(
          ctx.db
            .deleteFrom(PURGE_TABLES[object])
            .where("id", "in", part)
            .where("deleted_at", "is not", null)
            .where("deleted_at", "<", cutoff),
        );
      }
    }
    for (const record of purged) {
      ctx.recordChange({
        object: record.object,
        id: record.id,
        action: "erase",
        diff: { deletedAt: { before: record.deletedAt, after: "[purged]" } },
      });
    }
    return { cutoff, purged, more };
  },
});

export const trashOperations = [trashList, trashPurge] as const;
