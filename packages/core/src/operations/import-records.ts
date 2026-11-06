// import.records.*: CSV import of extension-object records (deals, …), stage 4b. People and
// organisations keep import.csv.* with their dedupe; extension objects map columns to fields by
// name or label, parse cells with the field-type registry's CSV rules, and resolve relation
// cells by id or by the target's title (an organisation by name, a pipeline by name) and user
// cells by id, email or name. Each record is created like record.create does (the stage
// behaviour and its history included), so imported deals obey stage rules.
//
// Stateless like import.csv.* (ADR 0020): preview and commit take the same CSV and mapping. A
// commit creates at most IMPORT_RECORDS_BATCH rows (`start`, `count`) in one batch, because every
// record adds statements to the operation's single D1 batch; the UI commits in chunks.
import { sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { FIELD_TYPE_REGISTRY } from "../fields/field-types.ts";
import { getObject, isCoreObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { StageCache } from "../records/stages.ts";
import { CSV_LIMITS, parseCsv } from "./import.ts";
import { createRecord } from "./record.ts";

export const IMPORT_RECORDS_BATCH = 100;

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function requireImportable(name: string): ObjectDefinition {
  const object = getObject(name);
  if (!object?.extension || isCoreObject(name) || !object.titleField) {
    throw new ValidationError(
      `${name} is not an extension object; import people and organisations with import.csv.*`,
      { object: name },
    );
  }
  return object;
}

/** Fields a CSV column can fill: the object's own writable extension fields. */
function importableFields(object: ObjectDefinition): FieldDefinition[] {
  return object.fields.filter((f) => f.extension === object.extension && !f.readOnly);
}

/** Header → field name, by field name or label (letters and digits, any case). */
export function suggestRecordMapping(
  object: ObjectDefinition,
  headers: readonly string[],
): Record<string, string | null> {
  const fields = importableFields(object);
  const used = new Set<string>();
  return Object.fromEntries(
    headers.map((header) => {
      const key = norm(header);
      const field = fields.find(
        (f) => !used.has(f.name) && (norm(f.name) === key || norm(f.label) === key),
      );
      if (field) used.add(field.name);
      return [header, field?.name ?? null];
    }),
  );
}

interface ParsedRow {
  row: number;
  values: Record<string, unknown>;
  errors: string[];
}

function readTable(csv: string) {
  const rows = parseCsv(csv);
  const [header, ...data] = rows;
  if (!header) throw new ValidationError("The CSV is empty");
  if (header.length > CSV_LIMITS.maxColumns) {
    throw new ValidationError(`At most ${CSV_LIMITS.maxColumns} columns`);
  }
  if (data.length > CSV_LIMITS.maxRows) {
    throw new ValidationError(`At most ${CSV_LIMITS.maxRows} rows`);
  }
  return { headers: header.map((h) => h.trim()), data };
}

/** Resolves relation and user cells (ids, titles, emails) for every row in a few queries. */
async function resolveReferences(
  ctx: Pick<HandlerContext, "db">,
  fields: FieldDefinition[],
  rows: ParsedRow[],
): Promise<void> {
  for (const field of fields) {
    const isUser = field.fieldType === "user";
    const isRelation = field.fieldType === "relation";
    if (!isUser && !isRelation) continue;
    const raw = new Set<string>();
    for (const row of rows) {
      const value = row.values[field.name];
      for (const v of Array.isArray(value) ? value : value == null ? [] : [value]) {
        raw.add(String(v));
      }
    }
    if (!raw.size) continue;
    const list = JSON.stringify([...raw]);
    const lower = JSON.stringify([...raw].map((v) => v.toLowerCase()));
    const found = new Map<string, string>();
    if (isUser) {
      const users = await sql<{ id: string; email: string; name: string }>`
        SELECT id, email, name FROM core_user WHERE kind = 'human' AND (
          id IN (SELECT value FROM json_each(${list}))
          OR lower(email) IN (SELECT value FROM json_each(${lower}))
          OR lower(name) IN (SELECT value FROM json_each(${lower})))
      `.execute(ctx.db);
      for (const u of users.rows) {
        for (const key of [u.id, u.email.toLowerCase(), u.name.toLowerCase()]) found.set(key, u.id);
      }
    } else {
      const target = getObject(String(field.options?.to ?? ""));
      const titleColumn =
        target?.name === "organisation"
          ? "name"
          : target?.name === "person"
            ? "display_name"
            : target?.titleField
              ? target.fields.find((f) => f.name === target.titleField)?.column
              : undefined;
      if (target && titleColumn) {
        const records = await sql<{ id: string; title: string | null }>`
          SELECT id, ${sql.ref(titleColumn)} AS title FROM ${sql.table(target.source)}
          WHERE id IN (SELECT value FROM json_each(${list}))
            OR lower(${sql.ref(titleColumn)}) IN (SELECT value FROM json_each(${lower}))
        `.execute(ctx.db);
        for (const r of records.rows) {
          found.set(r.id, r.id);
          // The first match by title wins; ids always win.
          const key = (r.title ?? "").toLowerCase();
          if (key && !found.has(key)) found.set(key, r.id);
        }
      }
    }
    for (const row of rows) {
      const value = row.values[field.name];
      if (value == null) continue;
      const resolve = (v: unknown) => found.get(String(v)) ?? found.get(String(v).toLowerCase());
      if (Array.isArray(value)) {
        const ids = value.map(resolve);
        const missing = value.filter((_, i) => !ids[i]);
        if (missing.length) row.errors.push(`${field.label}: no match for ${missing.join(", ")}`);
        else row.values[field.name] = ids;
      } else {
        const id = resolve(value);
        if (!id) row.errors.push(`${field.label}: no match for "${String(value)}"`);
        else row.values[field.name] = id;
      }
    }
  }
}

async function parseRows(
  ctx: Pick<HandlerContext, "db">,
  object: ObjectDefinition,
  csv: string,
  given: Record<string, string | null> | undefined,
  range?: { start: number; count: number },
) {
  const { headers, data } = readTable(csv);
  const mapping = given ?? suggestRecordMapping(object, headers);
  const fields = importableFields(object);
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const [header, field] of Object.entries(mapping)) {
    if (field !== null && !byName.has(field)) {
      throw new ValidationError(`Column "${header}" maps to unknown field "${field}"`, {
        field,
        allowed: fields.map((f) => f.name),
      });
    }
  }
  const start = range?.start ?? 0;
  const slice = data.slice(start, range ? start + range.count : undefined);
  const rows: ParsedRow[] = slice.map((cells, i) => {
    const row: ParsedRow = { row: start + i + 1, values: {}, errors: [] };
    headers.forEach((header, column) => {
      const name = mapping[header];
      const field = name ? byName.get(name) : undefined;
      if (!field) return;
      const cell = (cells[column] ?? "").trim();
      try {
        const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
        const manifest = {
          type,
          label: field.label,
          ...(field.options?.many !== undefined ? { many: field.options.many } : {}),
        };
        let value = FIELD_TYPE_REGISTRY[type].csv.parse(cell, manifest);
        if (type === "select" && typeof value === "string") {
          // Option labels work as well as values.
          const choice = field.options?.choices?.find(
            (c) => c.value === value || norm(c.label) === norm(String(value)),
          );
          value = choice?.value ?? value;
        }
        if (value !== null) row.values[field.name] = value;
      } catch (error) {
        row.errors.push(`${field.label}: ${error instanceof Error ? error.message : "invalid"}`);
      }
    });
    for (const field of fields) {
      if (field.required && row.values[field.name] == null) {
        row.errors.push(`${field.label} is required`);
      }
    }
    return row;
  });
  await resolveReferences(ctx, fields, rows);
  return { headers, mapping, rows, total: data.length, fields };
}

const inputSchema = z.object({
  object: z.string().min(1).max(80).describe("An extension object, e.g. deals.deal"),
  csv: z.string().min(1).max(CSV_LIMITS.maxBytes).describe("The CSV text, header row first"),
  mapping: z
    .record(z.string(), z.string().nullable())
    .optional()
    .describe("Column header → field name (null ignores the column). Omit to use the suggestions."),
});

export const importRecordsPreview = defineOperation({
  name: "import.records.preview",
  description:
    "Preview a CSV import of records of an extension object (e.g. deals.deal): the suggested " +
    "column → field mapping (by field name or label), the parsed values of the first rows, and " +
    "every row's problems (unparseable cells, missing required fields, relation cells that match " +
    "no record by id or title, users that match no id, email or name). Stage rules are checked on " +
    "commit. Read-only.",
  input: inputSchema,
  output: z.object({
    headers: z.array(z.string()),
    mapping: z.record(z.string(), z.string().nullable()),
    fields: z.array(z.object({ name: z.string(), label: z.string(), required: z.boolean() })),
    total: z.number(),
    rows: z.array(
      z.object({
        row: z.number(),
        values: z.record(z.string(), z.unknown()),
        errors: z.array(z.string()),
      }),
    ),
    invalid: z.number(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requireImportable(input.object);
    const parsed = await parseRows(ctx, object, input.csv, input.mapping);
    return {
      headers: parsed.headers,
      mapping: parsed.mapping,
      fields: parsed.fields.map((f) => ({
        name: f.name,
        label: f.label,
        required: Boolean(f.required),
      })),
      total: parsed.total,
      rows: parsed.rows.slice(0, 50),
      invalid: parsed.rows.filter((r) => r.errors.length).length,
    };
  },
});

export const importRecordsCommit = defineOperation({
  name: "import.records.commit",
  description:
    "Create records of an extension object from CSV rows start…start+count (at most " +
    `${IMPORT_RECORDS_BATCH} per call; call again with the next start for more), with the same ` +
    "mapping preview showed. Every record is created like record.create (stage rules, default " +
    "stage, probability and stage history for deals), all in one transaction: a row with a " +
    "problem fails the whole call with the row number, unless skipInvalid is set. Returns the " +
    "created ids and skipped rows.",
  input: inputSchema.extend({
    start: z.number().int().min(0).default(0).describe("0-based index of the first data row"),
    count: z.number().int().min(1).max(IMPORT_RECORDS_BATCH).default(IMPORT_RECORDS_BATCH),
    skipInvalid: z.boolean().default(false),
  }),
  output: z.object({
    created: z.array(z.string()),
    skipped: z.array(z.object({ row: z.number(), errors: z.array(z.string()) })),
    total: z.number(),
    next: z.number().nullable().describe("The start of the next chunk, or null when done"),
  }),
  permission: "records:write",
  risk: "bulk-write",
  bulkSize: (input) => input.count,
  async handler(input, ctx) {
    const object = requireImportable(input.object);
    const parsed = await parseRows(ctx, object, input.csv, input.mapping, {
      start: input.start,
      count: input.count,
    });
    const skipped: { row: number; errors: string[] }[] = [];
    const created: string[] = [];
    const cache: StageCache = new Map();
    for (const row of parsed.rows) {
      if (row.errors.length) {
        if (!input.skipInvalid) {
          throw new ValidationError(`Row ${row.row}: ${row.errors.join("; ")}`, {
            row: row.row,
            errors: row.errors,
          });
        }
        skipped.push({ row: row.row, errors: row.errors });
        continue;
      }
      try {
        created.push(
          await createRecord(ctx, object, row.values, {
            cache,
            checkReferences: false,
            // Bulk: the audit diff names the rule; no timeline post per row.
            assignmentTimeline: false,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!input.skipInvalid) {
          throw new ValidationError(`Row ${row.row}: ${message}`, {
            row: row.row,
            ...((error as { details?: object }).details ?? {}),
          });
        }
        skipped.push({ row: row.row, errors: [message] });
      }
    }
    const end = input.start + input.count;
    return { created, skipped, total: parsed.total, next: end < parsed.total ? end : null };
  },
});

export const importRecordsOperations = [importRecordsPreview, importRecordsCommit] as const;
