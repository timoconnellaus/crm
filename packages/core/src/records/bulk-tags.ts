// Adding and removing tags on many records at once (the *.updateMany operations).
import { sql } from "kysely";
import { z } from "zod";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk } from "./common.ts";
import { compareTagNames, loadTags, tagNameSchema, uniqueTagNames } from "./tags.ts";

export const bulkTagListSchema = z.array(tagNameSchema).max(10);

/**
 * Queues adding `add` and removing `remove` on every record in `ids`, creating unknown tags.
 * Returns each record's tags before and after, for the audit diffs.
 */
export async function queueBulkTags(
  ctx: HandlerContext,
  object: string,
  ids: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): Promise<{ before: Map<string, string[]>; after: Map<string, string[]> }> {
  const before = new Map<string, string[]>();
  for (const part of chunk(ids)) {
    for (const [id, tags] of await loadTags(ctx.db, object, part)) before.set(id, tags);
  }
  const addNames = uniqueTagNames(add);
  const removeNames = uniqueTagNames(remove);
  if (!addNames.length && !removeNames.length) return { before, after: before };

  const existing = addNames.length
    ? await ctx.db
        .selectFrom("core_tags")
        .select(["id", "name"])
        .where("name", "in", addNames)
        .execute()
    : [];
  const canonical = new Map(existing.map((t) => [t.name.toLowerCase(), t.name]));
  const missing = addNames.filter((n) => !canonical.has(n.toLowerCase()));
  if (missing.length) {
    ctx.write(
      ctx.db
        .insertInto("core_tags")
        .values(
          missing.map((name) => ({
            id: newId("tag"),
            name,
            created_at: ctx.now,
            created_by: ctx.user.id,
          })),
        )
        .onConflict((oc) => oc.column("name").doNothing()),
    );
  }
  for (const part of chunk(ids)) {
    if (removeNames.length) {
      ctx.write(
        ctx.db
          .deleteFrom("core_record_tags")
          .where("object_type", "=", object)
          .where("record_id", "in", part)
          .where("tag_id", "in", (eb) =>
            eb.selectFrom("core_tags").select("id").where("name", "in", removeNames),
          ),
      );
    }
    if (addNames.length) {
      // Ids travel as one JSON parameter (json_each), keeping well under D1's parameter limit.
      ctx.write(
        ctx.db
          .insertInto("core_record_tags")
          .orIgnore()
          .columns(["tag_id", "object_type", "record_id", "created_at"])
          .expression(
            ctx.db
              .selectFrom("core_tags as t")
              .innerJoin(sql<{ value: string }>`json_each(${JSON.stringify(part)})`.as("r"), (j) =>
                j.onTrue(),
              )
              .select([
                "t.id",
                sql<string>`${object}`.as("object_type"),
                "r.value as record_id",
                sql<string>`${ctx.now}`.as("created_at"),
              ])
              .where("t.name", "in", addNames),
          ),
      );
    }
  }

  const removeKeys = new Set(removeNames.map((n) => n.toLowerCase()));
  const addCanonical = addNames.map((n) => canonical.get(n.toLowerCase()) ?? n);
  const after = new Map<string, string[]>();
  for (const [id, tags] of before) {
    const next = new Map(tags.map((t) => [t.toLowerCase(), t]));
    for (const key of removeKeys) next.delete(key);
    for (const name of addCanonical) {
      if (!next.has(name.toLowerCase())) next.set(name.toLowerCase(), name);
    }
    after.set(id, [...next.values()].sort(compareTagNames));
  }
  return { before, after };
}
