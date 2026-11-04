// Trigger records and conditions (ADR 0130). An automation's declarative `conditions` are the view
// filter language, compiled by the same compiler (filter.ts) over the object's crm_* view and
// checked against the current record before a run is created. A run's event carries the trigger
// record as read when it started.
import type { CoreDatabase } from "@crm/db";
import type { ViewFilter } from "@crm/sdk";
import { type Kysely, sql } from "kysely";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { compileFilter, type Filter } from "../filter.ts";
import { chunk, jsonList } from "../records/common.ts";
import { resolveRelative } from "../relative.ts";

// biome-ignore lint/suspicious/noExplicitAny: crm_* views are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

export interface TriggerRecord {
  object: string;
  id: string;
  title: string | null;
  /** Field values by registry name. */
  data: Record<string, unknown>;
  deleted: boolean;
}

function decode(object: ObjectDefinition, row: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { id: row.id };
  for (const field of object.fields) {
    if (!field.column || !(field.column in row)) continue;
    const raw = row[field.column] ?? null;
    if (field.extension && field.fieldType) {
      const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
      data[field.name] =
        type === "formula"
          ? formulaFromStorage(field.options?.resultType, raw)
          : (FIELD_TYPE_REGISTRY[type]?.fromStorage(raw) ?? raw);
    } else {
      data[field.name] = raw;
    }
  }
  return data;
}

function titleOf(object: ObjectDefinition, row: Record<string, unknown>): string | null {
  const column = object.titleField
    ? object.fields.find((f) => f.name === object.titleField)?.column
    : undefined;
  const value = column ? row[column] : (row.name ?? row.display_name ?? row.title ?? row.subject);
  return value == null ? null : String(value);
}

/** The record a run is about, as its `event.record` (null when it no longer exists). */
export async function loadTriggerRecord(
  db: Kysely<CoreDatabase>,
  object: string,
  id: string,
): Promise<TriggerRecord | null> {
  await refreshSchemaRegistry(db);
  const def = getObject(object);
  if (!def) return null;
  const row = (await (db as AnyDb).selectFrom(def.source).selectAll().where("id", "=", id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    object,
    id,
    title: titleOf(def, row),
    data: decode(def, row),
    deleted: row.deleted_at != null,
  };
}

/**
 * The ids among `ids` whose current record satisfies `conditions` (all of them when there are
 * none). One query per 50 ids over the object's view, by primary key. Relative values resolve
 * against `userId` (the extension principal) and `now`.
 */
export async function idsMatchingConditions(
  db: Kysely<CoreDatabase>,
  object: string,
  ids: readonly string[],
  conditions: ViewFilter | undefined,
  context: { userId: string; now: string },
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!conditions || !unique.length) return new Set(unique);
  await refreshSchemaRegistry(db);
  const def = getObject(object);
  if (!def) return new Set();
  const filter = resolveRelative(conditions, context.userId, context.now) as Filter;
  const where = compileFilter(def, filter, "r");
  const out = new Set<string>();
  for (const part of chunk(unique)) {
    const rows = await sql<{ id: string }>`
      SELECT r.id AS id FROM ${sql.table(def.source)} AS r
      WHERE r.id IN ${jsonList(part)} AND ${where}
    `.execute(db);
    for (const row of rows.rows) out.add(row.id);
  }
  return out;
}

/**
 * Ids of live records of `object` whose date field `field` falls on `date` (`YYYY-MM-DD`): the
 * field), at most `limit` ids.
 */
export async function recordsOnDate(
  db: Kysely<CoreDatabase>,
  object: string,
  field: string,
  date: string,
  limit: number,
): Promise<string[]> {
  await refreshSchemaRegistry(db);
  const def = getObject(object);
  const column = def?.fields.find((f) => f.name === field)?.column;
  if (!def || !column) return [];
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const rows = await sql<{ id: string }>`
    SELECT id FROM ${sql.table(def.source)}
    WHERE ${sql.ref(column)} >= ${date} AND ${sql.ref(column)} < ${next}
    ORDER BY ${sql.ref(column)}
    LIMIT ${limit}
  `.execute(db);
  return rows.rows.map((r) => r.id);
}
