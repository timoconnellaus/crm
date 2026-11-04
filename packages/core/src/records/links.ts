// Moving a record's activity links, task links and tags onto another record (merge), and the
// linked activities/tasks a hard delete (erase) removes with it.
import { type SqlBool, sql } from "kysely";
import type { HandlerContext } from "../operation.ts";

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
  // Erase passes a record plus the few merged into it, well under the parameter limit.
  if (recordIds.length > 40) throw new Error("findOwnedActivitiesAndTasks: too many records");
  const mine = sql.join(recordIds);
  const activities = await ctx.db
    .selectFrom("core_activity as a")
    .select("a.id")
    .where(
      sql<SqlBool>`a.id IN (SELECT l.activity_id FROM core_activity_links l
        WHERE l.object_type = ${object} AND l.record_id IN (${mine}))`,
    )
    .where(
      sql<SqlBool>`(a.type = 'system' OR NOT EXISTS (SELECT 1 FROM core_activity_links o
        WHERE o.activity_id = a.id AND NOT (o.object_type = ${object} AND o.record_id IN (${mine}))))`,
    )
    .execute();
  const tasks = await ctx.db
    .selectFrom("core_task as t")
    .select("t.id")
    .where(
      sql<SqlBool>`t.id IN (SELECT l.task_id FROM core_task_links l
        WHERE l.object_type = ${object} AND l.record_id IN (${mine}))`,
    )
    .where(
      sql<SqlBool>`NOT EXISTS (SELECT 1 FROM core_task_links o
        WHERE o.task_id = t.id AND NOT (o.object_type = ${object} AND o.record_id IN (${mine})))`,
    )
    .execute();
  const activityIds = activities.map((a) => a.id);
  const taskIds = tasks.map((t) => t.id);
  return { activityIds: [...new Set(activityIds)], taskIds: [...new Set(taskIds)] };
}
