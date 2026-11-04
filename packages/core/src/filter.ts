// Structured filter JSON (ADR 0016): `{ and | or: [...] }` groups of `{ field, op, value }`,
// validated against an object's field registry and compiled to parameterised SQL.
//
// Safety: field names are looked up in the registry and only registry-defined identifiers reach
// the SQL text. Every user value is a bound parameter. LIKE patterns escape `%`, `_` and `\`.
import { type RawBuilder, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { FieldDefinition, FieldType, ObjectDefinition } from "./fields/types.ts";

export const FILTER_OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value?: unknown;
}
export type Filter = FilterCondition | { and: Filter[] } | { or: Filter[] };

export const FILTER_LIMITS = { maxDepth: 5, maxConditions: 100, maxListValues: 500 } as const;

const conditionSchema = z
  .object({
    field: z.string().min(1).max(64),
    op: z.enum(FILTER_OPS),
    value: z.unknown().optional(),
  })
  .strict();

/** Zod schema for filter JSON. Structure only; fields and values are checked by compileFilter. */
export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ and: z.array(filterSchema).max(FILTER_LIMITS.maxConditions) }).strict(),
    z.object({ or: z.array(filterSchema).max(FILTER_LIMITS.maxConditions) }).strict(),
  ]),
) as z.ZodType<Filter>;

const COMPARABLE: FilterOp[] = ["eq", "neq", "lt", "lte", "gt", "gte", "between", "in", "not_in"];
const NULLS: FilterOp[] = ["is_null", "is_not_null"];
const TEXT: FilterOp[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
];

/** Which ops each field type supports. */
export const OPS_BY_TYPE: Record<FieldType, readonly FilterOp[]> = {
  text: [...TEXT, ...NULLS],
  number: [...COMPARABLE, ...NULLS],
  date: [...COMPARABLE, ...NULLS],
  datetime: [...COMPARABLE, ...NULLS],
  boolean: ["eq", "neq", ...NULLS],
  id: ["eq", "neq", "in", "not_in", ...NULLS],
  enum: ["eq", "neq", "in", "not_in", ...NULLS],
  json: [],
};

/** Ops a multi-valued (related) field supports: "has a value that …" and their negations. */
const RELATED_OPS: readonly FilterOp[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  ...NULLS,
];
const NEGATED: Partial<Record<FilterOp, FilterOp>> = {
  neq: "eq",
  not_in: "in",
  not_contains: "contains",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

type SqlValue = string | number | null;

function fail(path: string, reason: string): never {
  throw new ValidationError(`Invalid filter at ${path}: ${reason}`, { path, reason });
}

function scalar(field: FieldDefinition, value: unknown, path: string): SqlValue {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") fail(path, `${field.name} needs a string`);
      if (value.length > 1000) fail(path, "value is too long");
      return value;
    case "id":
      if (typeof value !== "string" || value.length > 100) fail(path, `${field.name} needs an id`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path, `${field.name} needs a number`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(path, `${field.name} needs true or false`);
      return value ? 1 : 0;
    case "date":
      if (typeof value !== "string" || !DATE_RE.test(value)) {
        fail(path, `${field.name} needs a YYYY-MM-DD date`);
      }
      return value;
    case "datetime":
      if (typeof value !== "string" || !DATETIME_RE.test(value)) {
        fail(path, `${field.name} needs an ISO-8601 date or timestamp`);
      }
      return value;
    case "enum":
      if (typeof value !== "string" || !field.enumValues?.includes(value)) {
        fail(path, `${field.name} must be one of ${field.enumValues?.join(", ")}`);
      }
      return value;
    case "json":
      return fail(path, `${field.name} cannot be filtered`);
  }
}

function list(field: FieldDefinition, value: unknown, path: string): SqlValue[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, "needs a non-empty array");
  if (value.length > FILTER_LIMITS.maxListValues) fail(path, "too many values");
  return value.map((item, i) => scalar(field, item, `${path}[${i}]`));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The comparison itself, against a column expression `col` (trusted). */
function comparison(
  field: FieldDefinition,
  col: RawBuilder<unknown>,
  op: FilterOp,
  value: unknown,
  path: string,
): RawBuilder<SqlBool> {
  const nocase = field.type === "text" ? sql` COLLATE NOCASE` : sql``;
  switch (op) {
    case "is_null":
      return sql<SqlBool>`${col} IS NULL`;
    case "is_not_null":
      return sql<SqlBool>`${col} IS NOT NULL`;
    case "eq":
      return sql<SqlBool>`${col} = ${scalar(field, value, path)}${nocase}`;
    case "neq":
      return sql<SqlBool>`(${col} IS NULL OR ${col} <> ${scalar(field, value, path)}${nocase})`;
    case "lt":
      return sql<SqlBool>`${col} < ${scalar(field, value, path)}`;
    case "lte":
      return sql<SqlBool>`${col} <= ${scalar(field, value, path)}`;
    case "gt":
      return sql<SqlBool>`${col} > ${scalar(field, value, path)}`;
    case "gte":
      return sql<SqlBool>`${col} >= ${scalar(field, value, path)}`;
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) fail(path, "between needs [low, high]");
      const [low, high] = list(field, value, path);
      return sql<SqlBool>`${col} BETWEEN ${low ?? null} AND ${high ?? null}`;
    }
    case "in":
      return sql<SqlBool>`${col}${nocase} IN (${sql.join(list(field, value, path))})`;
    case "not_in":
      return sql<SqlBool>`(${col} IS NULL OR ${col}${nocase} NOT IN (${sql.join(list(field, value, path))}))`;
    case "contains":
    case "not_contains":
    case "starts_with":
    case "ends_with": {
      const text = scalar(field, value, path);
      if (typeof text !== "string") fail(path, `${op} needs a string`);
      const escaped = escapeLike(text);
      const pattern =
        op === "starts_with" ? `${escaped}%` : op === "ends_with" ? `%${escaped}` : `%${escaped}%`;
      const like = sql<SqlBool>`${col} LIKE ${pattern} ESCAPE '\\'`;
      return op === "not_contains" ? sql<SqlBool>`(${col} IS NULL OR NOT (${like}))` : like;
    }
  }
}

interface CompileState {
  conditions: number;
}

function compileNode(
  object: ObjectDefinition,
  node: Filter,
  alias: string,
  path: string,
  depth: number,
  state: CompileState,
): RawBuilder<SqlBool> {
  if (depth > FILTER_LIMITS.maxDepth) fail(path, "filter is nested too deeply");
  if ("and" in node || "or" in node) {
    const isAnd = "and" in node;
    const children = isAnd ? (node as { and: Filter[] }).and : (node as { or: Filter[] }).or;
    const key = isAnd ? "and" : "or";
    if (children.length === 0) return isAnd ? sql<SqlBool>`1 = 1` : sql<SqlBool>`1 = 0`;
    const parts = children.map((child, i) =>
      compileNode(object, child, alias, `${path}.${key}[${i}]`, depth + 1, state),
    );
    return sql<SqlBool>`(${sql.join(parts, sql.raw(isAnd ? " AND " : " OR "))})`;
  }

  state.conditions += 1;
  if (state.conditions > FILTER_LIMITS.maxConditions) fail(path, "too many conditions");
  const { field: name, op, value } = node;
  const field = object.fields.find((f) => f.name === name);
  if (!field) fail(path, `unknown field "${name}" on ${object.name}`);
  if (!field.filterable) fail(path, `${object.name}.${name} is not filterable`);

  if (field.related) {
    if (!RELATED_OPS.includes(op) || !OPS_BY_TYPE[field.type].includes(op)) {
      fail(path, `${op} is not supported on ${object.name}.${name}`);
    }
    const r = field.related;
    const extra = r.where ? sql` AND ${sql.raw(r.where)}` : sql``;
    const exists = (condition: RawBuilder<SqlBool> | null) =>
      sql<SqlBool>`EXISTS (SELECT 1 FROM ${sql.raw(r.from)} WHERE ${sql.raw(r.link)} = ${sql.ref(`${alias}.id`)}${extra}${condition ? sql` AND ${condition}` : sql``})`;
    if (op === "is_not_null") return exists(null);
    if (op === "is_null") return sql<SqlBool>`NOT ${exists(null)}`;
    const positive = NEGATED[op];
    const col = sql.raw(r.column);
    if (positive) {
      return sql<SqlBool>`NOT ${exists(comparison(field, col, positive, value, path))}`;
    }
    return exists(comparison(field, col, op, value, path));
  }

  if (!OPS_BY_TYPE[field.type].includes(op)) {
    fail(path, `${op} is not supported on ${field.type} field ${object.name}.${name}`);
  }
  if (!field.column) fail(path, `${object.name}.${name} has no column`);
  if (!NULLS.includes(op) && value === undefined) fail(path, `${op} needs a value`);
  return comparison(field, sql.ref(`${alias}.${field.column}`), op, value, path);
}

/**
 * Validates `filter` against `object`'s field registry and compiles it to a parameterised SQL
 * condition over the object's list source (aliased `alias`, default the source name). Throws
 * ValidationError on unknown fields, unsupported ops, bad values or oversized filters.
 */
export function compileFilter(
  object: ObjectDefinition,
  filter: Filter,
  alias: string = object.source,
): RawBuilder<SqlBool> {
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) {
    throw new ValidationError("Invalid filter", { issues: parsed.error.issues });
  }
  return compileNode(object, parsed.data, alias, "filter", 1, { conditions: 0 });
}
