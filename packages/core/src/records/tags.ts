// Tags on any record (core_tags + polymorphic core_record_tags). Shared by person, organisation
// and later task/extension operations.
import type { CoreDatabase } from "@crm/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "./common.ts";

export const tagNameSchema = z.string().trim().min(1).max(50);
export const tagsInputSchema = z
  .array(tagNameSchema)
  .max(50)
  .describe("Tag names. Unknown tags are created. Replaces the record's tags.");

/** Tags per record id, sorted by name. */
export async function loadTags(
  db: Kysely<CoreDatabase>,
  object: string,
  recordIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(recordIds.map((id) => [id, []]));
  if (!recordIds.length) return result;
  const rows = await db
    .selectFrom("core_record_tags as rt")
    .innerJoin("core_tags as t", "t.id", "rt.tag_id")
    .select(["rt.record_id", "t.name"])
    .where("rt.object_type", "=", object)
    .where("rt.record_id", "in", jsonList(recordIds))
    .orderBy(sql`t.name COLLATE NOCASE`)
    .execute();
  for (const row of rows) result.get(row.record_id)?.push(row.name);
  return result;
}

/** De-duplicates names case-insensitively, keeping the first spelling. */
export function uniqueTagNames(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
  }
  return [...seen.values()];
}

/**
 * Queues writes that set a record's tags to exactly `names`, creating unknown tags. Returns the
 * canonical names (existing tags keep their stored spelling), sorted, for the after-snapshot.
 */
export async function queueSetTags(
  ctx: HandlerContext,
  object: string,
  recordId: string,
  names: readonly string[],
): Promise<string[]> {
  const unique = uniqueTagNames(names);
  const existing = unique.length
    ? await ctx.db
        .selectFrom("core_tags")
        .select(["id", "name"])
        .where("name", "in", unique)
        .execute()
    : [];
  const canonical = new Map(existing.map((tag) => [tag.name.toLowerCase(), tag.name]));
  const missing = unique.filter((name) => !canonical.has(name.toLowerCase()));

  ctx.write(
    ctx.db
      .deleteFrom("core_record_tags")
      .where("object_type", "=", object)
      .where("record_id", "=", recordId),
  );
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
  if (unique.length) {
    // Link by name through a subselect, so a tag created concurrently is still found.
    ctx.write(
      ctx.db
        .insertInto("core_record_tags")
        .columns(["tag_id", "object_type", "record_id", "created_at"])
        .expression(
          ctx.db
            .selectFrom("core_tags")
            .select([
              "id",
              sql<string>`${object}`.as("object_type"),
              sql<string>`${recordId}`.as("record_id"),
              sql<string>`${ctx.now}`.as("created_at"),
            ])
            .where("name", "in", unique),
        ),
    );
  }
  return unique.map((name) => canonical.get(name.toLowerCase()) ?? name).sort(compareTagNames);
}

/** The order loadTags returns (SQLite NOCASE: ASCII case-folded, then code units). */
export function compareTagNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
