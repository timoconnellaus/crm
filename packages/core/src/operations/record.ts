// record.* operations: generic records of extension objects, and extension fields on any object
// (ADR 0023). They read the crm_* views and write x_* tables, validated against the field registry
// and the field-type registry, so lists, filters, search, saved views, history (audit diffs) and
// timeline tracking work for extension schema exactly as for core objects.
//
// Core objects keep their own operations (person.update, …); `record.update` on a core object
// writes only extension fields (into side tables), and `record.get` returns them.
import type { CoreDatabase } from "@crm/db";
import type { FieldManifest } from "@crm/sdk";
import { CompiledQuery, type Kysely, type SelectQueryBuilder, sql } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { fieldStorage, objectTableOf } from "../extensions/schema.ts";
import { FIELD_TYPE_REGISTRY, formulaFromStorage } from "../fields/field-types.ts";
import { getObject, isCoreObject, listObjects } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import { listInputSchema, pageSchema, runListQuery } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList, restorableUntil, TRASH_RETENTION_DAYS } from "../records/common.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/)
  .describe("Object: an extension object (`<extension>.<object>`) or a core object");
const recordId = z.string().min(1).max(64).describe("Record id");
const valuesSchema = z
  .record(z.string().max(80), z.unknown())
  .describe("Field values by registry field name (see schema.objects)");

export const recordSchema = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  values: z.record(z.string(), z.unknown()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type RecordOutput = z.infer<typeof recordSchema>;

// biome-ignore lint/suspicious/noExplicitAny: x_* tables and crm_x_* views are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

function requireObject(name: string): ObjectDefinition {
  const object = getObject(name);
  if (!object) throw new ValidationError(`Unknown object "${name}"`, { object: name });
  return object;
}

function requireExtensionObject(name: string): ObjectDefinition & { titleField: string } {
  const object = requireObject(name);
  if (isCoreObject(name) || !object.extension || !object.titleField) {
    throw new ValidationError(
      `${name} is a core object; use its own operations (e.g. ${name}.create)`,
      { object: name },
    );
  }
  return object as ObjectDefinition & { titleField: string };
}

/** The extension fields of an object's registry entry (everything but system and core fields). */
function extensionFields(object: ObjectDefinition): FieldDefinition[] {
  return object.fields.filter((f) => f.extension);
}

function manifestOf(field: FieldDefinition): FieldManifest {
  return {
    type: field.fieldType as FieldManifest["type"],
    label: field.label,
    ...(field.options?.choices ? { options: [...field.options.choices] } : {}),
    ...(field.options?.to ? { to: field.options.to } : {}),
    ...(field.options?.many !== undefined ? { many: field.options.many } : {}),
  };
}

function fromRow(object: ObjectDefinition, row: Record<string, unknown>): RecordOutput {
  const values: Record<string, unknown> = {};
  for (const field of extensionFields(object)) {
    const type = field.fieldType as keyof typeof FIELD_TYPE_REGISTRY;
    const column = viewColumnOf(field);
    const rawValue = column ? row[column] : null;
    values[field.name] =
      type === "formula"
        ? formulaFromStorage(field.options?.resultType, rawValue)
        : FIELD_TYPE_REGISTRY[type].fromStorage(rawValue ?? null);
  }
  const titleColumn = object.titleField
    ? object.fields.find((f) => f.name === object.titleField)?.column
    : undefined;
  const titleValue = titleColumn ? row[titleColumn] : (row.name ?? row.display_name ?? row.title);
  return {
    object: object.name,
    id: String(row.id),
    title: titleValue == null ? null : String(titleValue),
    values,
    createdAt: (row.created_at as string | undefined) ?? null,
    updatedAt: (row.updated_at as string | undefined) ?? null,
  };
}

async function loadRecord(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  id: string,
): Promise<RecordOutput | null> {
  const row = await (db as AnyDb)
    .selectFrom(object.source)
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? fromRow(object, row as Record<string, unknown>) : null;
}

/** The stored column of a multi-valued field (whose registry entry has no `column`). */
function viewColumnOf(field: FieldDefinition): string | null {
  if (field.column) return field.column;
  const match = /json_each\(r2\.([a-z0-9_]+)\)/.exec(field.related?.from ?? "");
  return match?.[1] ?? null;
}

interface PreparedValue {
  field: FieldDefinition;
  value: unknown;
  stored: string | number | null;
  table: string;
  column: string;
  own: boolean;
}

/** Validates `values` for writing; returns them with their storage. */
async function prepareValues(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
  mode: "create" | "update",
): Promise<PreparedValue[]> {
  const prepared: PreparedValue[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = object.fields.find((f) => f.name === name);
    if (!field) {
      throw new ValidationError(`Unknown field "${name}" on ${object.name}`, {
        field: name,
        allowed: extensionFields(object)
          .filter((f) => !f.readOnly)
          .map((f) => f.name),
      });
    }
    if (!field.extension) {
      throw new ValidationError(
        `${object.name}.${name} is a core field; change it with ${object.name}.update`,
        { field: name },
      );
    }
    if (field.readOnly) {
      throw new ValidationError(`${object.name}.${name} is computed and cannot be set`, {
        field: name,
      });
    }
    const storage = fieldStorage(object.name, name);
    if (!storage?.column) throw new ValidationError(`${object.name}.${name} cannot be written`);
    const spec = FIELD_TYPE_REGISTRY[storage.type];
    const parsed = spec.schema(manifestOf(field)).safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(`Invalid value for ${object.name}.${name}`, {
        field: name,
        issues: parsed.error.issues,
      });
    }
    if (field.required && (parsed.data === null || parsed.data === "")) {
      throw new ValidationError(`${object.name}.${name} is required`, { field: name });
    }
    prepared.push({
      field,
      value: parsed.data,
      stored: spec.toStorage(parsed.data),
      table: storage.table,
      column: storage.column,
      own: storage.own,
    });
  }
  if (mode === "create") {
    for (const field of extensionFields(object)) {
      if (field.required && !prepared.some((p) => p.field.name === field.name)) {
        const storage = fieldStorage(object.name, field.name);
        if (storage?.own) {
          throw new ValidationError(`${object.name}.${field.name} is required`, {
            field: field.name,
          });
        }
      }
    }
  }
  await assertReferences(ctx, prepared);
  return prepared;
}

/**
 * Select choices may require other fields (ADR 0058): a record holding the choice must have a
 * value in each. `values` is the record as it will be after the write. Refuses with the first
 * missing field named in `details.field`, so a board drag can ask for it.
 */
export function assertChoiceRequirements(
  object: ObjectDefinition,
  prepared: readonly { field: FieldDefinition; value: unknown }[],
  values: Record<string, unknown>,
): void {
  for (const p of prepared) {
    const choice = p.field.options?.choices?.find((c) => c.value === p.value);
    if (!choice?.requires?.length) continue;
    const prefix = p.field.name.includes(".") ? `${p.field.name.split(".")[0]}.` : "";
    const missing = choice.requires
      .map((name) => object.fields.find((f) => f.name === name || f.name === `${prefix}${name}`))
      .filter((f): f is FieldDefinition => Boolean(f))
      .filter((f) => {
        const value = values[f.name];
        return value === null || value === undefined || value === "" ||
          (Array.isArray(value) && value.length === 0);
      });
    const first = missing[0];
    if (first) {
      throw new ValidationError(
        `${p.field.label} “${choice.label}” needs ${missing.map((f) => f.label).join(", ")}`,
        {
          field: first.name,
          fields: missing.map((f) => f.name),
          reason: "required_by_choice",
          choiceField: p.field.name,
          choice: choice.value,
        },
      );
    }
  }
}

/** Relation and user fields must point at live records and real users. */
async function assertReferences(ctx: HandlerContext, prepared: PreparedValue[]) {
  for (const p of prepared) {
    if (p.value == null) continue;
    const ids = Array.isArray(p.value) ? (p.value as string[]) : [String(p.value)];
    if (!ids.length) continue;
    if (p.field.fieldType === "user") {
      const found = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("id", "in", jsonList(ids))
        .where("kind", "=", "human")
        .execute();
      if (found.length !== new Set(ids).size) {
        throw new ValidationError(`${p.field.name}: no such user`, { field: p.field.name });
      }
      continue;
    }
    if (p.field.fieldType === "relation" && p.field.options?.to) {
      const target = getObject(p.field.options.to);
      if (!target) throw new ValidationError(`${p.field.name}: unknown target object`);
      const found = await (ctx.db as AnyDb)
        .selectFrom(target.source)
        .select("id")
        .where("id", "in", jsonList(ids))
        .execute();
      const have = new Set(found.map((r) => String((r as { id: string }).id)));
      const missing = [...new Set(ids)].filter((id) => !have.has(id));
      if (missing.length) {
        throw new ValidationError(
          `${p.field.name}: no live ${target.name} with id ${missing.join(", ")}`,
          {
            field: p.field.name,
            missing,
          },
        );
      }
    }
  }
}

/** Upserts side-table values (one statement per side table). */
function sideWrites(id: string, prepared: PreparedValue[]): CompiledQuery[] {
  const byTable = new Map<string, PreparedValue[]>();
  for (const p of prepared.filter((x) => !x.own)) {
    byTable.set(p.table, [...(byTable.get(p.table) ?? []), p]);
  }
  return [...byTable].map(([table, values]) => {
    const columns = values.map((v) => v.column);
    return CompiledQuery.raw(
      `INSERT INTO ${table} (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")}) ON CONFLICT (id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      [id, ...values.map((v) => v.stored)],
    );
  });
}

function searchDoc(object: string, id: string, title: string | null): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_search_docs WHERE object_type = ? AND record_id = ?", [
      object,
      id,
    ]),
    CompiledQuery.raw(
      "INSERT INTO core_search_docs (object_type, record_id, title, body) VALUES (?, ?, ?, '')",
      [object, id, title ?? ""],
    ),
  ];
}

function snapshot(record: RecordOutput): Record<string, unknown> {
  return { ...record.values };
}

export const recordCreate = defineOperation({
  name: "record.create",
  description:
    "Create a record of an extension object (`<extension>.<object>`, see schema.objects) with " +
    "field values by name. Formula fields are computed and cannot be set; relation fields take " +
    "record ids (an array when the field holds many). Returns the stored record. Core objects " +
    "(person, organisation, …) use their own create operations.",
  input: z.object({ object: objectName, values: valuesSchema.default({}) }),
  output: recordSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const prepared = await prepareValues(ctx, object, input.values, "create");
    assertChoiceRequirements(
      object,
      prepared,
      Object.fromEntries(prepared.map((p) => [p.field.name, p.value])),
    );
    const table = objectTableOf(object.name) as string;
    const id = newId("record");
    const own = prepared.filter((p) => p.own);
    const columns = ["id", "created_at", "updated_at", "created_by", ...own.map((p) => p.column)];
    ctx.write(
      CompiledQuery.raw(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        [id, ctx.now, ctx.now, ctx.user.id, ...own.map((p) => p.stored)],
      ),
      ...sideWrites(id, prepared),
    );
    const title = prepared.find((p) => p.field.name === object.titleField)?.value;
    ctx.write(...searchDoc(object.name, id, title == null ? null : String(title)));
    const after = Object.fromEntries(prepared.map((p) => [p.field.name, p.value]));
    ctx.recordChange({ object: object.name, id, action: "create", after });
    return ctx.afterCommit(async () => (await loadRecord(ctx.db, object, id)) as RecordOutput);
  },
});

export const recordGet = defineOperation({
  name: "record.get",
  description:
    "Get one record by object and id. For extension objects returns every field; for core " +
    "objects returns only the values of extension fields (use person.get etc. for core fields). " +
    "Read-only.",
  input: z.object({ object: objectName, id: recordId }),
  output: recordSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requireObject(input.object);
    const record = await loadRecord(ctx.db, object, input.id);
    if (!record) throw new NotFoundError(input.object, input.id);
    return record;
  },
});

export const recordUpdate = defineOperation({
  name: "record.update",
  description:
    "Update field values of a record. On extension objects any writable field; on core objects " +
    "only extension fields (named `<extension>.<field>`). Pass null to clear a value. Changes " +
    "are recorded in the record's history; fields tracked on the timeline post a system " +
    "activity. Returns the stored record.",
  input: z.object({ object: objectName, id: recordId, values: valuesSchema }),
  output: recordSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireObject(input.object);
    const before = await loadRecord(ctx.db, object, input.id);
    if (!before) throw new NotFoundError(input.object, input.id);
    const prepared = await prepareValues(ctx, object, input.values, "update");
    if (!prepared.length) return before;
    assertChoiceRequirements(object, prepared, {
      ...before.values,
      ...Object.fromEntries(prepared.map((p) => [p.field.name, p.value])),
    });
    const own = prepared.filter((p) => p.own);
    if (own.length || !isCoreObject(object.name)) {
      const table = objectTableOf(object.name);
      if (table) {
        ctx.write(
          CompiledQuery.raw(
            `UPDATE ${table} SET ${[...own.map((p) => `${p.column} = ?`), "updated_at = ?", "updated_by = ?"].join(", ")} WHERE id = ? AND deleted_at IS NULL`,
            [...own.map((p) => p.stored), ctx.now, ctx.user.id, input.id],
          ),
        );
      }
    }
    ctx.write(...sideWrites(input.id, prepared));
    const after = {
      ...before.values,
      ...Object.fromEntries(prepared.map((p) => [p.field.name, p.value])),
    };
    if (object.titleField && prepared.some((p) => p.field.name === object.titleField)) {
      const title = after[object.titleField];
      ctx.write(...searchDoc(object.name, input.id, title == null ? null : String(title)));
    }
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: snapshot(before),
      after,
    });
    return ctx.afterCommit(
      async () => (await loadRecord(ctx.db, object, input.id)) as RecordOutput,
    );
  },
});

export const recordDelete = defineOperation({
  name: "record.delete",
  description:
    `Move a record of an extension object to Trash (soft delete). It can be restored with ` +
    `record.restore for ${TRASH_RETENTION_DAYS} days. Returns the id and the restore deadline.`,
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ id: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const before = await loadRecord(ctx.db, object, input.id);
    if (!before) throw new NotFoundError(input.object, input.id);
    const table = objectTableOf(object.name) as string;
    ctx.write(
      CompiledQuery.raw(`UPDATE ${table} SET deleted_at = ?, deleted_by = ? WHERE id = ?`, [
        ctx.now,
        ctx.user.id,
        input.id,
      ]),
      CompiledQuery.raw("DELETE FROM core_search_docs WHERE object_type = ? AND record_id = ?", [
        object.name,
        input.id,
      ]),
    );
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "delete",
      before: snapshot(before),
    });
    return { id: input.id, restorableUntil: restorableUntil(ctx.now) };
  },
});

export const recordRestore = defineOperation({
  name: "record.restore",
  description:
    "Restore a record of an extension object from Trash (within 30 days of its deletion). " +
    "Returns the restored record.",
  input: z.object({ object: objectName, id: recordId }),
  output: recordSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const table = objectTableOf(object.name) as string;
    const row = await sql<{ deleted_at: string | null }>`
      SELECT deleted_at FROM ${sql.table(table)} WHERE id = ${input.id}
    `.execute(ctx.db);
    const deletedAt = row.rows[0]?.deleted_at;
    if (deletedAt === undefined) throw new NotFoundError(input.object, input.id);
    if (deletedAt === null) throw new ValidationError(`${input.id} is not in Trash`);
    ctx.write(
      CompiledQuery.raw(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`, [
        input.id,
      ]),
    );
    ctx.recordChange({ object: object.name, id: input.id, action: "restore", diff: {} });
    return ctx.afterCommit(async () => {
      const record = (await loadRecord(ctx.db, object, input.id)) as RecordOutput;
      await ctx.db
        .insertInto("core_search_docs")
        .values({
          object_type: object.name,
          record_id: input.id,
          title: record.title ?? "",
          body: "",
        })
        .onConflict((oc) => oc.columns(["object_type", "record_id"]).doNothing())
        .execute();
      return record;
    });
  },
});

export const recordList = defineOperation({
  name: "record.list",
  description:
    "List records of an extension object (or a core object's extension fields) with the same " +
    "filter JSON, sort and cursor as other list operations. Every field in schema.objects is " +
    "filterable, including formula fields; multi-valued fields match any value. Read-only.",
  input: listInputSchema.extend({ object: objectName }),
  output: pageSchema(recordSchema),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requireObject(input.object);
    const page = await runListQuery(
      (ctx.db as AnyDb).selectFrom(object.source).selectAll() as ReturnType<AnyDb["selectFrom"]> &
        SelectQueryBuilder<CoreDatabase, keyof CoreDatabase, { id: string }>,
      object,
      input,
    );
    const items = page.rows.map((row) => {
      const record = fromRow(object, row as Record<string, unknown>);
      if (input.fields) {
        record.values = Object.fromEntries(
          Object.entries(record.values).filter(([key]) => input.fields?.includes(key)),
        );
        // Core fields named in `fields` come back too (board, calendar and gallery views of
        // core objects read them here), as their view columns' values.
        for (const name of input.fields) {
          const field = object.fields.find((f) => f.name === name);
          if (field && !field.extension && field.column && !(name in record.values)) {
            record.values[name] = (row as Record<string, unknown>)[field.column] ?? null;
          }
        }
      }
      return record;
    });
    return { items, nextCursor: page.nextCursor };
  },
});

const fieldInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  fieldType: z.string().nullable(),
  enumValues: z.array(z.string()).nullable(),
  multi: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  readOnly: z.boolean(),
  required: z.boolean(),
  track: z.boolean(),
  extension: z.string().nullable(),
  description: z.string().nullable(),
  options: z.record(z.string(), z.unknown()).nullable(),
});
export type FieldInfo = z.infer<typeof fieldInfoSchema>;

export const objectInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  plural: z.string().nullable(),
  icon: z.string().nullable(),
  titleField: z.string().nullable(),
  extension: z.string().nullable(),
  description: z.string().nullable(),
  /** The crm_* view, for query.sql. */
  view: z.string(),
  fields: z.array(fieldInfoSchema),
});
export type ObjectInfo = z.infer<typeof objectInfoSchema>;

export function objectInfo(object: ObjectDefinition): ObjectInfo {
  return {
    name: object.name,
    label: object.label,
    plural: object.plural ?? null,
    icon: object.icon ?? null,
    titleField: object.titleField ?? null,
    extension: object.extension ?? null,
    description: object.description ?? null,
    view: object.source,
    fields: object.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      fieldType: f.fieldType ?? null,
      enumValues: f.enumValues ? [...f.enumValues] : null,
      multi: Boolean(f.related),
      filterable: f.filterable,
      sortable: f.sortable,
      readOnly: Boolean(f.readOnly),
      required: Boolean(f.required),
      track: f.track === "timeline",
      extension: f.extension ?? null,
      description: f.description ?? null,
      options: f.options ? { ...f.options } : null,
    })),
  };
}

export const schemaObjects = defineOperation({
  name: "schema.objects",
  description:
    "List every object in the field registry (core objects and extension objects) with their " +
    "fields: name, label, type, filterability, sortability, whether computed, and type options " +
    "(select choices, relation target, formula expression). Use it before record.* and list " +
    "filters. Read-only.",
  input: z.object({ object: objectName.optional() }),
  output: z.object({ objects: z.array(objectInfoSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input) {
    const objects = input.object ? [requireObject(input.object)] : listObjects();
    return { objects: objects.map(objectInfo) };
  },
});

export { viewColumnOf };

export const recordOperations = [
  recordCreate,
  recordGet,
  recordUpdate,
  recordDelete,
  recordRestore,
  recordList,
  schemaObjects,
] as const;
