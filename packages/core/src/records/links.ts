// Polymorphic record links (core_activity_links, core_task_links): an activity or task points at
// any number of records by (object type, record id). Shared by activity.* and task.* operations.
//
// LINK_TARGETS lists the objects a link may point at and how to check that a record exists. Stage
// 3 adds extension objects here (generated from validated identifiers, never from user input).
import type { CoreDatabase } from "@crm/db";
import { type Kysely, type RawBuilder, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import type { RecordRef } from "../operation.ts";

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

/** `(SELECT value FROM json_each(?))`: an IN-list of any length in one bound parameter. D1 caps
 * bound parameters per statement at 100, so long lists must not be spread as `?, ?, ...`. */
export function jsonList<T extends string | number>(values: readonly T[]): RawBuilder<T> {
  return sql<T>`(SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/** Removes duplicate refs, keeping order. */
export function uniqueRefs(refs: readonly RecordRef[]): RecordRef[] {
  return [...new Map(refs.map((r) => [`${r.object}:${r.id}`, r] as const)).values()];
}

/** Fails with ValidationError unless every ref names a known object and a live record. */
export async function assertLinkTargets(
  db: Kysely<CoreDatabase>,
  refs: readonly RecordRef[],
): Promise<void> {
  const byObject = new Map<string, string[]>();
  for (const ref of refs) {
    if (!Object.hasOwn(LINK_TARGETS, ref.object)) {
      throw new ValidationError(`Cannot link to object type "${ref.object}"`, {
        field: "links",
        allowed: Object.keys(LINK_TARGETS),
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
