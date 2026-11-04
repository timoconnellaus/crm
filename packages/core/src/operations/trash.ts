// trash.* operations: what is in Trash (soft-deleted people, organisations, activities and tasks)
// and the scheduled purge that hard-deletes people and organisations once their 30-day restore
// window has passed.
import { type SqlBool, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { decodeCursor, encodeCursor } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { chunk, purgeCutoff, restorableUntil, TRASH_RETENTION_DAYS } from "../records/common.ts";

/** Records trash.purge hard-deletes after the retention window. */
const TRASH_OBJECTS = ["person", "organisation"] as const;
/** Everything trash.list shows and the UI can restore (people, orgs, activities, tasks). */
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

export const trashPurge = defineOperation({
  name: "trash.purge",
  description:
    `Permanently delete people and organisations that have been in Trash for more than ` +
    `${TRASH_RETENTION_DAYS} days (oldest first, at most limit per call), with their emails, ` +
    "phones, domains, addresses, affiliations, tags and links. Activities and tasks are kept. " +
    "Run by the scheduled purge as an automation; it never touches records still within " +
    "their restore window. Returns what was purged and whether more is due.",
  input: z.object({
    limit: z.number().int().min(1).max(PURGE_MAX).default(50),
  }),
  output: z.object({
    cutoff: z.string().describe("Records deleted before this were due"),
    purged: z.array(
      z.object({ object: z.enum(TRASH_OBJECTS), id: z.string(), deletedAt: z.string() }),
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
    const due = async (table: "core_person" | "core_organisation", limit: number) =>
      limit <= 0
        ? []
        : table === "core_person"
          ? ctx.db
              .selectFrom("core_person")
              .select(["id", "deleted_at"])
              .where("deleted_at", "is not", null)
              .where("deleted_at", "<", cutoff)
              .orderBy("deleted_at")
              .orderBy("id")
              .limit(limit)
              .execute()
          : ctx.db
              .selectFrom("core_organisation")
              .select(["id", "deleted_at"])
              .where("deleted_at", "is not", null)
              .where("deleted_at", "<", cutoff)
              .orderBy("deleted_at")
              .orderBy("id")
              .limit(limit)
              .execute();

    // Ask for one more than the limit to learn whether another call is needed.
    const people = await due("core_person", input.limit + 1);
    const organisations = await due("core_organisation", input.limit + 1 - people.length);
    const more = people.length + organisations.length > input.limit;
    const takePeople = people.slice(0, input.limit);
    const takeOrgs = organisations.slice(0, input.limit - takePeople.length);

    // People first: their affiliations cascade before the organisations go.
    for (const part of chunk(takePeople.map((p) => p.id))) {
      ctx.write(
        ctx.db
          .deleteFrom("core_person")
          .where("id", "in", part)
          .where("deleted_at", "is not", null)
          .where("deleted_at", "<", cutoff),
      );
    }
    for (const part of chunk(takeOrgs.map((o) => o.id))) {
      ctx.write(
        ctx.db
          .deleteFrom("core_organisation")
          .where("id", "in", part)
          .where("deleted_at", "is not", null)
          .where("deleted_at", "<", cutoff),
      );
    }
    const purged = [
      ...takePeople.map((p) => ({
        object: "person" as const,
        id: p.id,
        deletedAt: p.deleted_at ?? "",
      })),
      ...takeOrgs.map((o) => ({
        object: "organisation" as const,
        id: o.id,
        deletedAt: o.deleted_at ?? "",
      })),
    ];
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
