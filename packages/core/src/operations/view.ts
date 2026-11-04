// view.* operations: a user's saved list views (ADR 0016). A view spec is a `table`-type spec
// `{ type: "table", object, filter, sort, columns }`, validated against the field registry.
// Stage 4 adds more spec types to the discriminated union; stored table specs stay valid.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { CORE_OBJECTS, getObject } from "../fields/index.ts";
import { compileFilter, filterSchema } from "../filter.ts";
import { newId } from "../ids.ts";
import { resolveSort, sortSchema } from "../list.ts";
import { defineOperation } from "../operation.ts";

const viewId = z.string().startsWith("vw_").max(64).describe("Saved view id (vw_…)");
const objectName = z.enum(Object.keys(CORE_OBJECTS) as [keyof typeof CORE_OBJECTS]);

export const tableViewSpecSchema = z.object({
  type: z.literal("table"),
  object: objectName.describe("The object listed: person, organisation, activity or task"),
  filter: filterSchema.nullish().describe("Structured filter JSON, as list operations take"),
  sort: sortSchema.nullish(),
  columns: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(100)
    .describe("Field names shown, in order"),
});
export const viewSpecSchema = z.discriminatedUnion("type", [tableViewSpecSchema]);
export type ViewSpec = z.infer<typeof viewSpecSchema>;

export const savedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  object: z.string(),
  spec: viewSpecSchema,
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedView = z.infer<typeof savedViewSchema>;

/** Checks a spec against the field registry; returns it normalised for storage. */
export function validateViewSpec(spec: ViewSpec): ViewSpec {
  const object = getObject(spec.object);
  if (!object) throw new ValidationError(`Unknown object ${spec.object}`);
  if (spec.filter) compileFilter(object, spec.filter);
  if (spec.sort) resolveSort(object, spec.sort);
  const names = new Set(object.fields.map((f) => f.name));
  const unknown = spec.columns.filter((c) => !names.has(c));
  if (unknown.length) {
    throw new ValidationError(`Unknown ${spec.object} columns: ${unknown.join(", ")}`, {
      field: "columns",
    });
  }
  if (new Set(spec.columns).size !== spec.columns.length) {
    throw new ValidationError("A column is listed twice", { field: "columns" });
  }
  return {
    type: "table",
    object: spec.object,
    filter: spec.filter ?? null,
    sort: spec.sort ?? null,
    columns: spec.columns,
  };
}

function toView(row: {
  id: string;
  name: string;
  object: string;
  spec: string;
  position: number;
  created_at: string;
  updated_at: string;
}): SavedView {
  return {
    id: row.id,
    name: row.name,
    object: row.object,
    spec: JSON.parse(row.spec) as ViewSpec,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The caller's own view, or NotFoundError (other users' views are invisible). */
async function requireOwnView(db: Kysely<CoreDatabase>, id: string, userId: string) {
  const row = await db
    .selectFrom("core_views")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("view", id);
  return toView(row);
}

const snapshot = (v: Pick<SavedView, "name" | "spec" | "position">) => ({
  name: v.name,
  spec: v.spec,
  position: v.position,
});

const nameSchema = z.string().trim().min(1).max(200);

export const viewCreate = defineOperation({
  name: "view.create",
  description:
    "Save a list view for yourself: a name and a table view spec { type: 'table', object, " +
    "filter, sort, columns }. Filter, sort and columns are checked against the object's fields. " +
    "Views are private to the user who saves them. Returns the saved view.",
  input: z.object({
    name: nameSchema,
    spec: viewSpecSchema,
    position: z.number().int().min(0).max(10_000).optional().describe("Order in the view list"),
  }),
  output: savedViewSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const spec = validateViewSpec(input.spec);
    const id = newId("view");
    const position =
      input.position ??
      Number(
        (
          await ctx.db
            .selectFrom("core_views")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("user_id", "=", ctx.user.id)
            .where("object", "=", spec.object)
            .executeTakeFirst()
        )?.n ?? 0,
      );
    const view: SavedView = {
      id,
      name: input.name,
      object: spec.object,
      spec,
      position,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    ctx.write(
      ctx.db.insertInto("core_views").values({
        id,
        user_id: ctx.user.id,
        object: spec.object,
        name: input.name,
        spec: JSON.stringify(spec),
        position,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    ctx.recordChange({ object: "view", id, action: "create", after: snapshot(view) });
    return view;
  },
});

export const viewUpdate = defineOperation({
  name: "view.update",
  description:
    "Rename, reorder or change the spec of one of your saved views. A new spec replaces the old " +
    "one and is checked against the object's fields. Returns the updated view.",
  input: z.object({
    id: viewId,
    name: nameSchema.optional(),
    spec: viewSpecSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  }),
  output: savedViewSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireOwnView(ctx.db, input.id, ctx.user.id);
    const after: SavedView = {
      ...before,
      name: input.name ?? before.name,
      spec: input.spec ? validateViewSpec(input.spec) : before.spec,
      position: input.position ?? before.position,
      updatedAt: ctx.now,
    };
    after.object = after.spec.object;
    ctx.write(
      ctx.db
        .updateTable("core_views")
        .set({
          name: after.name,
          object: after.object,
          spec: JSON.stringify(after.spec),
          position: after.position,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id)
        .where("user_id", "=", ctx.user.id),
    );
    ctx.recordChange({
      object: "view",
      id: input.id,
      action: "update",
      before: snapshot(before),
      after: snapshot(after),
    });
    return after;
  },
});

export const viewDelete = defineOperation({
  name: "view.delete",
  description:
    "Delete one of your saved views. This removes only the saved list configuration, never " +
    "any records, and cannot be undone.",
  input: z.object({ id: viewId }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const view = await requireOwnView(ctx.db, input.id, ctx.user.id);
    ctx.write(
      ctx.db.deleteFrom("core_views").where("id", "=", input.id).where("user_id", "=", ctx.user.id),
    );
    ctx.recordChange({ object: "view", id: input.id, action: "delete", before: snapshot(view) });
    return { id: input.id, deleted: true as const };
  },
});

export const viewList = defineOperation({
  name: "view.list",
  description:
    "List your saved views, optionally for one object, in their saved order. Each has the full " +
    "spec to reload the list exactly. Read-only.",
  input: z.object({ object: objectName.optional() }),
  output: z.object({ items: z.array(savedViewSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db.selectFrom("core_views").selectAll().where("user_id", "=", ctx.user.id);
    if (input.object) query = query.where("object", "=", input.object);
    const rows = await query.orderBy("object").orderBy("position").orderBy("created_at").execute();
    return { items: rows.map(toView) };
  },
});

export const viewOperations = [viewCreate, viewUpdate, viewDelete, viewList] as const;
