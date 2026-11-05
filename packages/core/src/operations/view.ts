// view.* operations: saved views of any object (ADR 0016, ADR 0027, ADR 0056). A saved view is a
// name plus a view spec: `table`, `board`, `calendar` or `gallery` (views/spec.ts), validated
// against the field registry. Views are personal unless shared: everyone who can read records
// sees shared views; the owner and admins edit them. Stored stage-1 table specs stay valid.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  type ObjectViewSpec,
  objectViewSpecSchema,
  parseStoredViewSpec,
  validateViewSpec,
  viewObjectName,
} from "../views/spec.ts";

export {
  type BoardViewSpec,
  boardViewSpecSchema,
  type CalendarViewSpec,
  calendarViewSpecSchema,
  type GalleryViewSpec,
  galleryViewSpecSchema,
  type ObjectViewSpec,
  objectViewSpecSchema,
  parseStoredViewSpec,
  type TableViewSpec,
  tableViewSpecSchema,
  type ViewSpec,
  validateViewSpec,
  viewSpecSchema,
} from "../views/spec.ts";

const viewId = z.string().startsWith("vw_").max(64).describe("Saved view id (vw_…)");

export const savedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  object: z.string(),
  spec: objectViewSpecSchema,
  position: z.number(),
  /** Shared with the org: members see it; the owner and admins edit it. */
  shared: z.boolean(),
  ownerId: z.string(),
  /** Whether the caller may change or delete it. */
  canEdit: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedView = z.infer<typeof savedViewSchema>;

interface ViewRow {
  id: string;
  user_id: string;
  name: string;
  object: string;
  spec: string;
  position: number;
  shared: number;
  created_at: string;
  updated_at: string;
}

function toView(row: ViewRow, ctx: Pick<HandlerContext, "user">): SavedView {
  const owner = row.user_id === ctx.user.id;
  return {
    id: row.id,
    name: row.name,
    object: row.object,
    spec: parseStoredViewSpec(row.spec),
    position: row.position,
    shared: row.shared === 1,
    ownerId: row.user_id,
    canEdit: owner || (row.shared === 1 && ctx.user.role === "admin"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The id of extension `ext`'s shipped view `name`. */
export function extensionViewId(ext: string, name: string): string {
  return `vw_x_${ext}_${name}`;
}

/**
 * Views active extensions ship (ADR 0103): shared, read-only, after people's own. A table spec
 * without columns shows the object's title and its next five fields. A declaration that no longer
 * fits the registry is left out.
 */
export async function extensionViews(
  db: Kysely<CoreDatabase>,
  object?: string,
): Promise<SavedView[]> {
  const rows = await db
    .selectFrom("core_extensions")
    .select(["id", "manifest", "installed_at", "updated_at"])
    .where("status", "=", "active")
    .orderBy("id")
    .execute();
  const out: SavedView[] = [];
  for (const row of rows) {
    const manifest = JSON.parse(row.manifest) as {
      views?: Record<string, Record<string, unknown> & { label: string; object: string }>;
    };
    let position = 1000;
    for (const [name, declared] of Object.entries(manifest.views ?? {})) {
      position += 1;
      if (object && declared.object !== object) continue;
      const { label, type, ...rest } = declared;
      const target = getObject(declared.object);
      if (!target) continue;
      const columns =
        (rest.columns as string[] | undefined) ??
        target.fields
          .filter((f) => f.extension === target.extension && f.column)
          .slice(0, 6)
          .map((f) => f.name);
      const parsed = objectViewSpecSchema.safeParse({
        ...rest,
        type: type ?? "table",
        ...((type ?? "table") === "table" ? { columns } : {}),
      });
      if (!parsed.success) continue;
      try {
        validateViewSpec(parsed.data);
      } catch {
        continue;
      }
      out.push({
        id: extensionViewId(row.id, name),
        name: label,
        object: declared.object,
        spec: parsed.data,
        position,
        shared: true,
        ownerId: `extension:${row.id}`,
        canEdit: false,
        createdAt: row.installed_at,
        updatedAt: row.updated_at,
      });
    }
  }
  return out;
}

/** A view the caller can see (their own, a shared one, or an extension's), or NotFoundError. */
async function requireVisibleView(
  db: Kysely<CoreDatabase>,
  ctx: Pick<HandlerContext, "user">,
  id: string,
): Promise<SavedView> {
  if (id.startsWith("vw_x_")) {
    const found = (await extensionViews(db)).find((v) => v.id === id);
    if (!found) throw new NotFoundError("view", id);
    return found;
  }
  const row = await db.selectFrom("core_views").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row || (row.user_id !== ctx.user.id && row.shared !== 1))
    throw new NotFoundError("view", id);
  return toView(row, ctx);
}

/** A view the caller may change: their own, or (as an admin) a shared one. */
async function requireEditableView(ctx: HandlerContext, id: string): Promise<SavedView> {
  const view = await requireVisibleView(ctx.db, ctx, id);
  if (!view.canEdit) {
    throw new ForbiddenError(
      view.id.startsWith("vw_x_")
        ? "This view ships with an extension and cannot be changed; save a copy as your own view"
        : "Only the view's owner or an admin can change a shared view",
    );
  }
  return view;
}

const snapshot = (v: Pick<SavedView, "name" | "spec" | "position" | "shared">) => ({
  name: v.name,
  spec: v.spec,
  position: v.position,
  shared: v.shared,
});

const nameSchema = z.string().trim().min(1).max(200);
const specDescription =
  "A view spec: { type: 'table', object, filter, sort, columns } | { type: 'board', object, " +
  "filter, groupBy (single-select field), sumField?, cardFields } | { type: 'calendar', object, " +
  "filter, dateField, mode: month|week|agenda, cardFields } | { type: 'gallery', object, filter, " +
  "sort, imageField?, cardFields }";

export const viewCreate = defineOperation({
  name: "view.create",
  description:
    `Save a view of an object's records: a name and ${specDescription}. Fields are checked ` +
    "against the object's registry. Personal by default; shared: true shows it to everyone in " +
    "the org (you and admins can change it). Returns the saved view.",
  input: z.object({
    name: nameSchema,
    spec: objectViewSpecSchema,
    shared: z.boolean().default(false),
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
    const row: ViewRow = {
      id,
      user_id: ctx.user.id,
      object: spec.object,
      name: input.name,
      spec: JSON.stringify(spec),
      position,
      shared: input.shared ? 1 : 0,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_views").values(row));
    const view = toView(row, ctx);
    ctx.recordChange({ object: "view", id, action: "create", after: snapshot(view) });
    return view;
  },
});

export const viewUpdate = defineOperation({
  name: "view.update",
  description:
    "Rename, reorder, share or change the spec of a saved view you own (admins may also change " +
    "shared views). A new spec replaces the old one, may change its type (table → board) and is " +
    "checked against the object's fields. Returns the updated view.",
  input: z.object({
    id: viewId,
    name: nameSchema.optional(),
    spec: objectViewSpecSchema.optional(),
    shared: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  }),
  output: savedViewSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireEditableView(ctx, input.id);
    if (input.shared === false && before.ownerId !== ctx.user.id) {
      throw new ForbiddenError("Only the owner can make a shared view personal again");
    }
    const spec: ObjectViewSpec = input.spec ? validateViewSpec(input.spec) : before.spec;
    const after: SavedView = {
      ...before,
      name: input.name ?? before.name,
      spec,
      object: spec.object,
      shared: input.shared ?? before.shared,
      position: input.position ?? before.position,
      updatedAt: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_views")
        .set({
          name: after.name,
          object: after.object,
          spec: JSON.stringify(after.spec),
          position: after.position,
          shared: after.shared ? 1 : 0,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
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
    "Delete a saved view you own (admins may also delete shared views). This removes only the " +
    "saved configuration, never any records, and cannot be undone.",
  input: z.object({ id: viewId }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const view = await requireEditableView(ctx, input.id);
    ctx.write(ctx.db.deleteFrom("core_views").where("id", "=", input.id));
    ctx.recordChange({ object: "view", id: input.id, action: "delete", before: snapshot(view) });
    return { id: input.id, deleted: true as const };
  },
});

export const viewGet = defineOperation({
  name: "view.get",
  description:
    "Get one saved view you can see (your own or a shared one) with its spec. Read-only.",
  input: z.object({ id: viewId }),
  output: savedViewSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  handler: (input, ctx) => requireVisibleView(ctx.db, ctx, input.id),
});

export const viewList = defineOperation({
  name: "view.list",
  description:
    "List the saved views you can use, optionally for one object: your own, every shared " +
    "view and the views installed extensions ship (e.g. Deals' My open deals), in their saved " +
    "order, each with its full spec (table, board, calendar or gallery) and whether you can " +
    "edit it. Filter values may be relative ({ $relative: 'me' | 'today' | 'startOfMonth' | … }), " +
    "resolved when the list runs. Read-only.",
  input: z.object({ object: viewObjectName.optional() }),
  output: z.object({ items: z.array(savedViewSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    // Two indexed reads (own by (user_id, object, position); shared by the partial index)
    // rather than one OR the planner would scan.
    let own = ctx.db.selectFrom("core_views").selectAll().where("user_id", "=", ctx.user.id);
    let shared = ctx.db
      .selectFrom("core_views")
      .selectAll()
      .where("shared", "=", 1)
      .where("user_id", "!=", ctx.user.id);
    if (input.object) {
      own = own.where("object", "=", input.object);
      shared = shared.where("object", "=", input.object);
    }
    const [mine, others] = await Promise.all([
      own.orderBy("object").orderBy("position").orderBy("created_at").execute(),
      shared.orderBy("object").orderBy("position").orderBy("created_at").limit(500).execute(),
    ]);
    const items = [...mine, ...others]
      .sort(
        (a, b) =>
          a.object.localeCompare(b.object) ||
          a.position - b.position ||
          a.created_at.localeCompare(b.created_at),
      )
      .map((row) => toView(row, ctx));
    return { items: [...items, ...(await extensionViews(ctx.db, input.object))] };
  },
});

export const viewOperations = [viewCreate, viewUpdate, viewDelete, viewGet, viewList] as const;
