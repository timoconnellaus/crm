// Polymorphic record links (core_activity_links, core_task_links): an activity or task points at
// any number of records by (object type, record id). Shared by activity.* and task.* operations
// (validating and loading links), and by merge and erase (moving links onto a survivor, and finding
// the activities and tasks an erase removes with a record).
//
// LINK_TARGETS lists the objects a link may point at and how to check that a record exists. Stage
// 3 adds extension objects here (generated from validated identifiers, never from user input).
import type { CoreDatabase } from "@crm/db";
import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import type { HandlerContext, RecordRef, SimulationView } from "../operation.ts";
import { jsonList } from "./common.ts";

interface LinkTarget {
  /** Core table holding the records. Trusted identifier. */
  table: "core_person" | "core_organisation" | "core_task";
  /** Column used as the record's display title. Trusted identifier. */
  titleColumn: string;
}

export const LINK_TARGETS: Record<string, LinkTarget> = {
  person: { table: "core_person", titleColumn: "display_name" },
  organisation: { table: "core_organisation", titleColumn: "name" },
  task: { table: "core_task", titleColumn: "title" },
};

export const recordRefSchema = z.object({
  object: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(64)
    .describe("Object type: person, organisation or task (extension objects later)"),
  id: z.string().min(1).max(64).describe("Record id, e.g. per_…"),
});

export const linkedRecordSchema = recordRefSchema.extend({
  title: z.string().nullable().describe("The record's display name, if it still exists"),
});
export type LinkedRecord = z.infer<typeof linkedRecordSchema>;

/** Removes duplicate refs, keeping order. */
export function uniqueRefs(refs: readonly RecordRef[]): RecordRef[] {
  return [...new Map(refs.map((r) => [`${r.object}:${r.id}`, r] as const)).values()];
}

/**
 * Fails with ValidationError unless every ref names a known object and a live record. While a
 * call is simulated for the approval queue (`simulation`), records the session's pending actions
 * create (provisional ids) count as live and records they delete do not.
 */
export async function assertLinkTargets(
  db: Kysely<CoreDatabase>,
  refs: readonly RecordRef[],
  simulation?: SimulationView,
): Promise<void> {
  const byObject = new Map<string, string[]>();
  for (const ref of refs) {
    if (!Object.hasOwn(LINK_TARGETS, ref.object)) {
      throw new ValidationError(`Cannot link to object type "${ref.object}"`, {
        field: "links",
        allowed: Object.keys(LINK_TARGETS),
      });
    }
    const sim = simulation?.record(ref.object, ref.id);
    if (sim) {
      if (sim.state === "live") continue;
      throw new ValidationError(`No live ${ref.object} with id ${ref.id} (pending deletion)`, {
        field: "links",
        object: ref.object,
        missing: [ref.id],
      });
    }
    byObject.set(ref.object, [...(byObject.get(ref.object) ?? []), ref.id]);
  }
  for (const [object, ids] of byObject) {
    const target = LINK_TARGETS[object] as LinkTarget;
    const found = await db
      .selectFrom(target.table)
      .select("id")
      .where("id", "in", jsonList(ids))
      .where("deleted_at", "is", null)
      .execute();
    const have = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) {
      throw new ValidationError(`No live ${object} with id ${missing.join(", ")}`, {
        field: "links",
        object,
        missing,
      });
    }
  }
}

/** Display titles for refs (deleted records included), keyed `object:id`. */
export async function loadRecordTitles(
  db: Kysely<CoreDatabase>,
  refs: readonly RecordRef[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const byObject = new Map<string, string[]>();
  for (const ref of refs) {
    if (Object.hasOwn(LINK_TARGETS, ref.object)) {
      byObject.set(ref.object, [...(byObject.get(ref.object) ?? []), ref.id]);
    }
  }
  await Promise.all(
    [...byObject].map(async ([object, ids]) => {
      const target = LINK_TARGETS[object] as LinkTarget;
      const rows = await db
        .selectFrom(target.table)
        .select(["id", sql<string>`${sql.ref(target.titleColumn)}`.as("title")])
        .where("id", "in", jsonList([...new Set(ids)]))
        .execute();
      for (const row of rows) titles.set(`${object}:${row.id}`, row.title);
    }),
  );
  return titles;
}

type LinkTable = "core_activity_links" | "core_task_links";
const OWNER_COLUMN = { core_activity_links: "activity_id", core_task_links: "task_id" } as const;

/** Links per owner id (activity or task), with record titles, in a stable order. */
export async function loadLinks(
  db: Kysely<CoreDatabase>,
  table: LinkTable,
  ownerIds: readonly string[],
): Promise<Map<string, LinkedRecord[]>> {
  const result = new Map<string, LinkedRecord[]>(ownerIds.map((id) => [id, []]));
  if (!ownerIds.length) return result;
  const owner = OWNER_COLUMN[table];
  const rows = await db
    .selectFrom(table)
    .select([sql<string>`${sql.ref(owner)}`.as("owner"), "object_type", "record_id"])
    .where(sql.ref(owner), "in", jsonList(ownerIds))
    .orderBy("object_type")
    .orderBy("record_id")
    .execute();
  const titles = await loadRecordTitles(
    db,
    rows.map((r) => ({ object: r.object_type, id: r.record_id })),
  );
  for (const row of rows) {
    result.get(row.owner)?.push({
      object: row.object_type,
      id: row.record_id,
      title: titles.get(`${row.object_type}:${row.record_id}`) ?? null,
    });
  }
  return result;
}

/** Sorted `object:id` strings, for audit snapshots. */
export function linkKeys(refs: readonly RecordRef[]): string[] {
  return refs.map((r) => `${r.object}:${r.id}`).sort();
}

// ---- Merge and erase -------------------------------------------------------------------------

/** How many activities and tasks link to `recordId`. */
export async function countLinks(
  ctx: HandlerContext,
  object: string,
  recordId: string,
): Promise<{ activities: number; tasks: number }> {
  const [activities, tasks] = await Promise.all([
    ctx.db
      .selectFrom("core_activity_links")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("object_type", "=", object)
      .where("record_id", "=", recordId)
      .executeTakeFirst(),
    ctx.db
      .selectFrom("core_task_links")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("object_type", "=", object)
      .where("record_id", "=", recordId)
      .executeTakeFirst(),
  ]);
  return { activities: Number(activities?.n ?? 0), tasks: Number(tasks?.n ?? 0) };
}

/**
 * Queues statements that re-point every activity and task link from `fromId` to `toId`. Links
 * that would duplicate one `toId` already has are dropped (the activity stays linked once).
 */
export function queueMoveLinks(
  ctx: HandlerContext,
  object: string,
  fromId: string,
  toId: string,
): void {
  ctx.write(
    ctx.db
      .insertInto("core_activity_links")
      .orIgnore()
      .columns(["activity_id", "object_type", "record_id"])
      .expression(
        ctx.db
          .selectFrom("core_activity_links")
          .select(["activity_id", "object_type", sql<string>`${toId}`.as("record_id")])
          .where("object_type", "=", object)
          .where("record_id", "=", fromId),
      ),
    ctx.db
      .deleteFrom("core_activity_links")
      .where("object_type", "=", object)
      .where("record_id", "=", fromId),
    ctx.db
      .insertInto("core_task_links")
      .orIgnore()
      .columns(["task_id", "object_type", "record_id"])
      .expression(
        ctx.db
          .selectFrom("core_task_links")
          .select(["task_id", "object_type", sql<string>`${toId}`.as("record_id")])
          .where("object_type", "=", object)
          .where("record_id", "=", fromId),
      ),
    ctx.db
      .deleteFrom("core_task_links")
      .where("object_type", "=", object)
      .where("record_id", "=", fromId),
  );
}

/** Removes every tag link of a record (the tags themselves stay in the vocabulary). */
export function queueClearTags(ctx: HandlerContext, object: string, recordId: string): void {
  ctx.write(
    ctx.db
      .deleteFrom("core_record_tags")
      .where("object_type", "=", object)
      .where("record_id", "=", recordId),
  );
}

/**
 * Activities and tasks that an erase of `recordIds` removes: activities linked only to those
 * records, every `system` activity linked to them (field changes, job changes and merges are
 * about the erased record), and tasks linked only to them. Shared ones just lose the link.
 */
export async function findOwnedActivitiesAndTasks(
  ctx: HandlerContext,
  object: string,
  recordIds: readonly string[],
): Promise<{ activityIds: string[]; taskIds: string[] }> {
  // One statement per kind over all ids, so "linked only to these records" sees every id.
  const mine = jsonList(recordIds);
  const activities = await ctx.db
    .selectFrom("core_activity as a")
    .select("a.id")
    .where(
      sql<SqlBool>`a.id IN (SELECT l.activity_id FROM core_activity_links l
        WHERE l.object_type = ${object} AND l.record_id IN ${mine})`,
    )
    .where(
      sql<SqlBool>`(a.type = 'system' OR NOT EXISTS (SELECT 1 FROM core_activity_links o
        WHERE o.activity_id = a.id AND NOT (o.object_type = ${object} AND o.record_id IN ${mine})))`,
    )
    .execute();
  const tasks = await ctx.db
    .selectFrom("core_task as t")
    .select("t.id")
    .where(
      sql<SqlBool>`t.id IN (SELECT l.task_id FROM core_task_links l
        WHERE l.object_type = ${object} AND l.record_id IN ${mine})`,
    )
    .where(
      sql<SqlBool>`NOT EXISTS (SELECT 1 FROM core_task_links o
        WHERE o.task_id = t.id AND NOT (o.object_type = ${object} AND o.record_id IN ${mine}))`,
    )
    .execute();
  return {
    activityIds: [...new Set(activities.map((a) => a.id))],
    taskIds: [...new Set(tasks.map((t) => t.id))],
  };
}
