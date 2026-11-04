// export.csv: a list (object + filter JSON + sort + columns) as CSV. Headers are field names, and
// people/organisation exports re-import with import.csv.* (the importer recognises the headers).
import { sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { compileFilter, filterSchema } from "../filter.ts";
import { resolveSort, sortSchema } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { toCsv } from "./import.ts";

export const EXPORT_OBJECTS = ["person", "organisation", "task", "activity"] as const;
type ExportObject = (typeof EXPORT_OBJECTS)[number];

/** Multi-valued fields exported from a JSON-array column of the object's view. */
const JSON_COLUMNS: Partial<Record<ExportObject, Record<string, string>>> = {
  person: { emails: "emails", tags: "tags" },
  organisation: { domains: "domains", tags: "tags" },
};

/** Exportable fields of an object, in registry order: single-valued view columns and JSON lists. */
export function exportableFields(
  object: ExportObject,
): { name: string; column: string; multi: boolean }[] {
  const definition = getObject(object);
  if (!definition) return [];
  const json = JSON_COLUMNS[object] ?? {};
  return definition.fields.flatMap((f): { name: string; column: string; multi: boolean }[] => {
    if (f.column && f.type !== "json") return [{ name: f.name, column: f.column, multi: false }];
    const column = json[f.name];
    return column ? [{ name: f.name, column, multi: true }] : [];
  });
}

export const EXPORT_LIMITS = { defaultRows: 10_000, maxRows: 50_000 } as const;

export const exportCsv = defineOperation({
  name: "export.csv",
  description:
    "Export a list to CSV: an object (person, organisation, task, activity), an optional filter " +
    "(the same filter JSON list operations take), a sort and the columns (field names; default " +
    "every exportable field). Multi-valued fields (emails, domains, tags) are joined with '; '. " +
    "Headers are field names, so people and organisation exports re-import with " +
    `import.csv.*. At most ${EXPORT_LIMITS.maxRows} rows. Returns the CSV text. Read-only.`,
  input: z.object({
    object: z.enum(EXPORT_OBJECTS),
    filter: filterSchema.nullish(),
    sort: sortSchema.nullish(),
    columns: z.array(z.string().min(1).max(64)).min(1).max(100).optional(),
    maxRows: z.number().int().min(1).max(EXPORT_LIMITS.maxRows).default(EXPORT_LIMITS.defaultRows),
  }),
  output: z.object({
    csv: z.string(),
    filename: z.string(),
    columns: z.array(z.string()),
    rowCount: z.number(),
    truncated: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = getObject(input.object);
    if (!object) throw new ValidationError(`Unknown object ${input.object}`);
    const available = exportableFields(input.object);
    const columns = input.columns ?? available.map((f) => f.name);
    const unknown = columns.filter((c) => !available.some((f) => f.name === c));
    if (unknown.length) {
      throw new ValidationError(`Cannot export ${input.object} columns: ${unknown.join(", ")}`, {
        allowed: available.map((f) => f.name),
      });
    }
    const fields = columns.map(
      (c) => available.find((f) => f.name === c) as (typeof available)[number],
    );

    const { sort, field } = resolveSort(object, input.sort ?? undefined);
    const alias = object.source;
    const ref = sql.ref(`${alias}.${field.column}`);
    const order = sql`${field.type === "text" ? sql`${ref} COLLATE NOCASE` : ref} ${sql.raw(sort.direction === "asc" ? "ASC" : "DESC")}, ${sql.ref(`${alias}.id`)} ${sql.raw(sort.direction === "asc" ? "ASC" : "DESC")}`;
    const where = input.filter ? sql`WHERE ${compileFilter(object, input.filter, alias)}` : sql``;
    const select = sql.join(fields.map((f) => sql.ref(`${alias}.${f.column}`)));
    const result = await sql<Record<string, unknown>>`
      SELECT ${select} FROM ${sql.table(alias)} ${where} ORDER BY ${order} LIMIT ${input.maxRows + 1}
    `.execute(ctx.db);

    const rows = result.rows.slice(0, input.maxRows);
    const text = (value: unknown, multi: boolean): string => {
      if (value === null || value === undefined) return "";
      if (multi) return (JSON.parse(String(value)) as unknown[]).map(String).join("; ");
      return String(value);
    };
    const csv = toCsv([
      columns,
      ...rows.map((row) => fields.map((f) => text(row[f.column], f.multi))),
    ]);
    return {
      csv,
      filename: `${input.object}-${ctx.now.slice(0, 10)}.csv`,
      columns,
      rowCount: rows.length,
      truncated: result.rows.length > input.maxRows,
    };
  },
});

export const exportOperations = [exportCsv] as const;
