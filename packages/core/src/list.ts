// Shared plumbing for `<object>.list` operations: input schema (filter, sort, cursor, limit,
// fields), keyset cursor pagination and field selection.
import { type RawBuilder, type SelectQueryBuilder, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { FieldDefinition, ObjectDefinition } from "./fields/types.ts";
import { compileFilter, filterSchema } from "./filter.ts";

export const sortSchema = z.object({
  field: z.string().min(1).max(64),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type Sort = z.infer<typeof sortSchema>;

export const LIST_MAX_LIMIT = 200;
export const LIST_DEFAULT_LIMIT = 50;

/** The input every list operation accepts. Extend it with `.extend({...})` for extra params. */
export const listInputSchema = z.object({
  filter: filterSchema
    .optional()
    .describe("Structured filter: { and | or: [...] } of { field, op, value }."),
  sort: sortSchema.optional().describe("Sort field and direction. Defaults per object."),
  cursor: z.string().max(1000).optional().describe("nextCursor from the previous page."),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  fields: z
    .array(z.string().min(1).max(64))
    .max(100)
    .optional()
    .describe("Return only these fields of each item (id is always included)."),
});
export type ListInput = z.infer<typeof listInputSchema>;

/** Output envelope of a list operation. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

interface CursorPayload {
  f: string;
  d: "asc" | "desc";
  v: string | number | null;
  id: string;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function encodeCursor(payload: CursorPayload): string {
  return base64UrlEncode(JSON.stringify(payload));
}

const cursorSchema = z.object({
  f: z.string(),
  d: z.enum(["asc", "desc"]),
  v: z.union([z.string(), z.number(), z.null()]),
  id: z.string(),
});

export function decodeCursor(cursor: string, sort: Sort): CursorPayload {
  let payload: CursorPayload;
  try {
    payload = cursorSchema.parse(JSON.parse(base64UrlDecode(cursor)));
  } catch {
    throw new ValidationError("Invalid cursor");
  }
  if (payload.f !== sort.field || payload.d !== sort.direction) {
    throw new ValidationError("Cursor was issued for a different sort; start from the first page");
  }
  return payload;
}

/** Resolves and validates the sort for `object`. */
export function resolveSort(
  object: ObjectDefinition,
  sort: Sort | undefined,
): {
  sort: Sort;
  field: FieldDefinition & { column: string };
} {
  const resolved = sort ?? object.defaultSort;
  const field = object.fields.find((f) => f.name === resolved.field);
  if (!field) throw new ValidationError(`Unknown sort field "${resolved.field}"`);
  if (!field.sortable || !field.column) {
    throw new ValidationError(`${object.name}.${resolved.field} is not sortable`);
  }
  return { sort: resolved, field: field as FieldDefinition & { column: string } };
}

function sortExpression(field: FieldDefinition & { column: string }, alias: string) {
  const ref = sql.ref(`${alias}.${field.column}`);
  return field.type === "text" ? sql`${ref} COLLATE NOCASE` : ref;
}

/** Keyset condition for "rows after the cursor" in (sort column, id) order. SQLite sorts NULLs
 * first ascending and last descending; the conditions follow that. */
function afterCursor(
  field: FieldDefinition & { column: string },
  alias: string,
  cursor: CursorPayload,
): RawBuilder<SqlBool> {
  const col = sortExpression(field, alias);
  const raw = sql.ref(`${alias}.${field.column}`);
  const id = sql.ref(`${alias}.id`);
  if (field.name === "id") {
    return cursor.d === "asc"
      ? sql<SqlBool>`${id} > ${cursor.id}`
      : sql<SqlBool>`${id} < ${cursor.id}`;
  }
  if (cursor.d === "asc") {
    return cursor.v === null
      ? sql<SqlBool>`((${raw} IS NULL AND ${id} > ${cursor.id}) OR ${raw} IS NOT NULL)`
      : sql<SqlBool>`(${col} > ${cursor.v} OR (${col} = ${cursor.v} AND ${id} > ${cursor.id}))`;
  }
  return cursor.v === null
    ? sql<SqlBool>`(${raw} IS NULL AND ${id} < ${cursor.id})`
    : sql<SqlBool>`(${col} < ${cursor.v} OR ${raw} IS NULL OR (${col} = ${cursor.v} AND ${id} < ${cursor.id}))`;
}

export interface ListPage<Row> {
  rows: Row[];
  nextCursor: string | null;
}

/**
 * Whether the page can stream in index order. The default sort of every core object (and `id`)
 * has an index, so SQLite walks it and computes the view's columns only for the rows it returns.
 */
function indexOrdered(object: ObjectDefinition, field: FieldDefinition): boolean {
  return field.name === "id" || field.name === object.defaultSort.field;
}

/**
 * Any other sort needs a temp B-tree, and SQLite computes every selected column (the crm_*
 * views' correlated subqueries: emails, phones, tags, counts) for every matching row before
 * sorting. Here it sorts ids alone, then loads the page's rows by primary key. For person.list
 * sorted by createdAt on 20k people, that cuts rows read from about 180k to about 20k
 * (docs/research/cloudflare-cost-audit.md).
 */
async function pageByIds<DB, TB extends keyof DB, Row extends { id: string }>(
  base: SelectQueryBuilder<DB, TB, Row>,
  ordered: SelectQueryBuilder<DB, TB, Row>,
  alias: string,
  column: string,
  take: number,
): Promise<Row[]> {
  const keys = (await ordered
    .clearSelect()
    .select([sql.ref(`${alias}.id`).as("id"), sql.ref(`${alias}.${column}`).as("sort_value")])
    .limit(take)
    .execute()) as unknown as { id: string }[];
  if (!keys.length) return [];
  const ids = keys.map((k) => k.id);
  const rows = await base
    .where(
      sql<SqlBool>`${sql.ref(`${alias}.id`)} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
    )
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Applies filter, cursor, sort and limit to `query` (a select over `object.source`, aliased
 * `alias`), runs it and returns one page. The query must select the `id` column and the sort
 * field's column under their own names (e.g. `selectAll()` on the crm_* view).
 */
export async function runListQuery<DB, TB extends keyof DB, Row extends { id: string }>(
  query: SelectQueryBuilder<DB, TB, Row>,
  object: ObjectDefinition,
  input: Pick<ListInput, "filter" | "sort" | "cursor" | "limit">,
  alias: string = object.source,
): Promise<ListPage<Row>> {
  const { sort, field } = resolveSort(object, input.sort);
  let q = query;
  if (input.filter) q = q.where(compileFilter(object, input.filter, alias));
  if (input.cursor) q = q.where(afterCursor(field, alias, decodeCursor(input.cursor, sort)));
  const direction = sql.raw(sort.direction === "asc" ? "ASC" : "DESC");
  if (field.name !== "id") q = q.orderBy(sql`${sortExpression(field, alias)} ${direction}`);
  q = q.orderBy(sql`${sql.ref(`${alias}.id`)} ${direction}`);

  const limit = input.limit ?? LIST_DEFAULT_LIMIT;
  const rows = indexOrdered(object, field)
    ? await q.limit(limit + 1).execute()
    : await pageByIds(query, q, alias, field.column, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const value = (last as Record<string, unknown>)[field.column];
    nextCursor = encodeCursor({
      f: sort.field,
      d: sort.direction,
      v: typeof value === "string" || typeof value === "number" ? value : null,
      id: last.id,
    });
  }
  return { rows: page, nextCursor };
}

/**
 * Field selection: returns `item` with only `fields` (plus `id`). Throws on unknown names, which
 * are checked against `allowed` (normally the output item schema's keys).
 */
export function selectFields<T extends { id: string }>(
  items: T[],
  fields: string[] | undefined,
  allowed: readonly string[],
): (Partial<T> & { id: string })[] {
  if (!fields) return items;
  const unknown = fields.filter((name) => !allowed.includes(name));
  if (unknown.length) throw new ValidationError(`Unknown fields: ${unknown.join(", ")}`);
  const keep = new Set(["id", ...fields]);
  return items.map(
    (item) =>
      Object.fromEntries(Object.entries(item).filter(([key]) => keep.has(key))) as Partial<T> & {
        id: string;
      },
  );
}
