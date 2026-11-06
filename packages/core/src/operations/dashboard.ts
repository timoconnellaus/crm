// dashboard.* and widget.* operations (ADR 0027, ADR 0057, ADR 0059). A dashboard is a title,
// filters and widgets over read-only SQL. Personal dashboards are private to their owner;
// shared ones are visible to every member and editable by admins and the owner. The shipped
// Overview lives in code (dashboards/overview.ts), is visible to all and is every user's Home
// until they choose another. Widgets run through the query.sql guards with bound named params,
// row and time limits, and a 60 s Cache API result cache; nothing here writes on read.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { describePrompt, extractJson } from "../dashboards/describe.ts";
import { OVERVIEW_DASHBOARD, OVERVIEW_DASHBOARD_ID } from "../dashboards/overview.ts";
import { runWidget, validateDashboardSpec } from "../dashboards/run.ts";
import {
  type DashboardSpec,
  dashboardFilterSchema,
  dashboardSpecSchema,
  filterValuesSchema,
  type WidgetSpec,
  widgetSpecSchema,
} from "../dashboards/spec.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
  askShape,
  type Shape,
  shapeHint,
  shapeMismatch,
  typeFits,
} from "../judge/questions/widget-shape.ts";
import type { ModelRunner } from "../models.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { assertNotLocked } from "../plugins/resolve.ts";

const dashboardId = z.string().min(1).max(64).describe("Dashboard id (dsh_…)");

export const dashboardSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  shared: z.boolean(),
  ownerId: z.string().nullable(),
  /** The shipped Overview: read-only, copy it to change it. */
  builtIn: z.boolean(),
  canEdit: z.boolean(),
  isHome: z.boolean(),
  filters: z.array(dashboardFilterSchema),
  widgets: z.array(widgetSpecSchema),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

const dashboardSummarySchema = dashboardSchema.omit({ filters: true, widgets: true }).extend({
  widgetCount: z.number(),
});

interface DashboardRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  shared: number;
  spec: string;
  created_at: string;
  updated_at: string;
}

const isAdmin = (ctx: Pick<HandlerContext, "user">) => ctx.user.role === "admin";

/** A dashboard that ships in code: the CRM's Overview, or one an active extension declares. */
interface ShippedDashboard {
  id: string;
  title: string;
  description: string;
  spec: DashboardSpec;
  /** Declared `home: true` by its extension (ADR 0103). */
  home: boolean;
}

/** The id of extension `ext`'s dashboard `name`. */
export function extensionDashboardId(ext: string, name: string): string {
  return `dsh_x_${ext}_${name}`;
}

/**
 * Shipped dashboards: the Overview, then those active extensions declare (ADR 0103), in extension
 * order. A declaration that no longer parses is left out.
 */
export async function shippedDashboards(db: Kysely<CoreDatabase>): Promise<ShippedDashboard[]> {
  const rows = await db
    .selectFrom("core_extensions")
    .select(["id", "manifest"])
    .where("status", "=", "active")
    .orderBy("id")
    .execute();
  const out: ShippedDashboard[] = [{ ...OVERVIEW_DASHBOARD, home: false }];
  for (const row of rows) {
    const manifest = JSON.parse(row.manifest) as {
      dashboards?: Record<string, { title: string; description?: string; home?: boolean }>;
    };
    for (const [name, declared] of Object.entries(manifest.dashboards ?? {})) {
      const spec = dashboardSpecSchema.safeParse(declared);
      if (!spec.success) continue;
      out.push({
        id: extensionDashboardId(row.id, name),
        title: declared.title,
        description: declared.description ?? "",
        spec: spec.data,
        home: declared.home === true,
      });
    }
  }
  return out;
}

/** Everyone's Home until they choose one: an extension's `home` dashboard, else the Overview. */
function defaultHomeId(shipped: readonly ShippedDashboard[]): string {
  return shipped.find((d) => d.home)?.id ?? OVERVIEW_DASHBOARD_ID;
}

function fromShipped(d: ShippedDashboard, homeId: string | null, fallback: string): Dashboard {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    shared: true,
    ownerId: null,
    builtIn: true,
    canEdit: false,
    isHome: (homeId ?? fallback) === d.id,
    filters: d.spec.filters,
    widgets: d.spec.widgets,
    createdAt: null,
    updatedAt: null,
  };
}

function fromRow(
  row: DashboardRow,
  ctx: Pick<HandlerContext, "user">,
  homeId: string | null,
): Dashboard {
  const spec = dashboardSpecSchema.parse(JSON.parse(row.spec));
  const owner = row.owner_id === ctx.user.id;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    shared: row.shared === 1,
    ownerId: row.owner_id,
    builtIn: false,
    canEdit: owner || (row.shared === 1 && isAdmin(ctx)),
    isHome: homeId === row.id,
    filters: spec.filters,
    widgets: spec.widgets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function homeIdOf(db: Kysely<CoreDatabase>, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("core_user_home")
    .select("dashboard_id")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.dashboard_id ?? null;
}

/** A dashboard the caller can see (Overview, shared, or their own), or null. */
async function findVisible(
  ctx: Pick<HandlerContext, "db" | "user">,
  id: string,
  homeId: string | null,
): Promise<Dashboard | null> {
  if (id === OVERVIEW_DASHBOARD_ID || id.startsWith("dsh_x_")) {
    const shipped = await shippedDashboards(ctx.db);
    const found = shipped.find((d) => d.id === id);
    return found ? fromShipped(found, homeId, defaultHomeId(shipped)) : null;
  }
  const row = await ctx.db
    .selectFrom("core_dashboards")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  if (row.shared !== 1 && row.owner_id !== ctx.user.id) return null;
  return fromRow(row, ctx, homeId);
}

async function requireVisible(ctx: HandlerContext, id: string): Promise<Dashboard> {
  const found = await findVisible(ctx, id, await homeIdOf(ctx.db, ctx.user.id));
  if (!found) throw new NotFoundError("dashboard", id);
  return found;
}

async function requireEditable(ctx: HandlerContext, id: string): Promise<Dashboard> {
  const dashboard = await requireVisible(ctx, id);
  if (dashboard.builtIn) {
    throw new ValidationError(
      `${dashboard.title} ships with Relationship OS and cannot be changed; copy it with dashboard.create { copyFrom: "${id}" }`,
      { field: "id" },
    );
  }
  if (!dashboard.canEdit) {
    throw new ForbiddenError(
      "Only the dashboard's owner or an admin can change a shared dashboard",
    );
  }
  return dashboard;
}

const snapshot = (
  d: Pick<Dashboard, "title" | "description" | "shared" | "filters" | "widgets">,
) => ({
  title: d.title,
  description: d.description,
  shared: d.shared,
  filters: d.filters,
  widgets: d.widgets.map((w) => ({ id: w.id, type: w.type, title: w.title, sql: w.sql ?? null })),
});

const titleSchema = z.string().trim().min(1).max(200);
const specFields = {
  filters: z
    .array(dashboardFilterSchema)
    .max(8)
    .optional()
    .describe(
      "Dashboard filters, each bound to named SQL params: dateRange `date` → :date_from/:date_to, " +
        "user `owner` → :owner, select/field/text `x` → :x",
    ),
  widgets: z.array(widgetSpecSchema).max(30).optional().describe("Widgets in layout order"),
};

async function checkedSpec(ctx: HandlerContext, spec: DashboardSpec): Promise<DashboardSpec> {
  return validateDashboardSpec(ctx.db, dashboardSpecSchema.parse(spec));
}

export const dashboardList = defineOperation({
  name: "dashboard.list",
  description:
    "List the dashboards you can open: the shipped ones (the Overview and those installed " +
    "extensions ship, e.g. Deals' Sales overview), every shared dashboard and your " +
    "own personal ones, with whether you can edit each and which is your Home. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(dashboardSummarySchema), homeId: z.string() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const homeId = await homeIdOf(ctx.db, ctx.user.id);
    const rows = await ctx.db
      .selectFrom("core_dashboards")
      .selectAll()
      .where((eb) => eb.or([eb("shared", "=", 1), eb("owner_id", "=", ctx.user.id)]))
      .orderBy("title")
      .orderBy("id")
      .limit(500)
      .execute();
    const shipped = await shippedDashboards(ctx.db);
    const fallback = defaultHomeId(shipped);
    const all = [
      ...shipped.map((d) => fromShipped(d, homeId, fallback)),
      ...rows.map((row) => fromRow(row, ctx, homeId)),
    ];
    const home =
      all.find((d) => d.isHome) ?? all.find((d) => d.id === fallback) ?? (all[0] as Dashboard);
    return {
      items: all.map(({ filters: _f, widgets, ...rest }) => ({
        ...rest,
        isHome: rest.id === home.id,
        widgetCount: widgets.length,
      })),
      homeId: home.id,
    };
  },
});

export const dashboardGet = defineOperation({
  name: "dashboard.get",
  description:
    "Get one dashboard you can open, with its filters and widgets (SQL, chart mapping, " +
    "click-through and layout). Read-only.",
  input: z.object({ id: dashboardId }),
  output: dashboardSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  handler: (input, ctx) => requireVisible(ctx, input.id),
});

export const dashboardHome = defineOperation({
  name: "dashboard.home",
  description:
    "Get your Home dashboard (the one shown at /): the one you set with dashboard.setHome, or " +
    "the default: an installed extension's home dashboard (Sales overview with Deals), else the " +
    "shipped Overview. Read-only.",
  input: z.object({}),
  output: dashboardSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const homeId = await homeIdOf(ctx.db, ctx.user.id);
    if (homeId) {
      const home = await findVisible(ctx, homeId, homeId);
      if (home) return home;
    }
    const shipped = await shippedDashboards(ctx.db);
    const fallback = defaultHomeId(shipped);
    const found = shipped.find((d) => d.id === fallback) as ShippedDashboard;
    return fromShipped(found, null, fallback);
  },
});

export const dashboardCreate = defineOperation({
  name: "dashboard.create",
  description:
    "Create a dashboard: a title, filters and widgets. Each data widget has read-only SQL over " +
    "the crm_* views (checked like query.sql) using named params from the filters (:date_from, " +
    ":date_to, :owner, …) and :now, :today, :me; a chart mapping; and optionally a " +
    "click-through { object, filter } whose filter values may be { $row } or { $param } " +
    "placeholders. Personal by default; shared: true makes it visible to every member. " +
    "copyFrom copies another dashboard's filters and widgets (e.g. the Overview). Try widgets " +
    "with widget.preview first. Returns the dashboard.",
  input: z.object({
    title: titleSchema,
    description: z.string().max(1000).nullish(),
    shared: z.boolean().default(false),
    copyFrom: dashboardId.optional().describe("Copy this dashboard's filters and widgets"),
    ...specFields,
  }),
  output: dashboardSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const source = input.copyFrom ? await requireVisible(ctx, input.copyFrom) : null;
    const spec = await checkedSpec(ctx, {
      filters: input.filters ?? source?.filters ?? [],
      widgets: input.widgets ?? source?.widgets ?? [],
    });
    const id = newId("dashboard");
    const row: DashboardRow = {
      id,
      owner_id: ctx.user.id,
      title: input.title,
      description: input.description ?? source?.description ?? null,
      shared: input.shared ? 1 : 0,
      spec: JSON.stringify(spec),
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_dashboards").values(row));
    const dashboard = fromRow(row, ctx, null);
    ctx.recordChange({ object: "dashboard", id, action: "create", after: snapshot(dashboard) });
    return dashboard;
  },
});

export const dashboardUpdate = defineOperation({
  name: "dashboard.update",
  description:
    "Change a dashboard you own (or, as an admin, a shared one): title, description, sharing, " +
    "filters or widgets. Filters and widgets replace the old lists whole, so send every widget " +
    "you want to keep (dashboard.get returns them). Returns the dashboard.",
  input: z.object({
    id: dashboardId,
    title: titleSchema.optional(),
    description: z.string().max(1000).nullish(),
    shared: z.boolean().optional(),
    ...specFields,
  }),
  output: dashboardSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireEditable(ctx, input.id);
    await assertNotLocked(ctx, "dashboard", input.id);
    if (input.shared === false && before.ownerId !== ctx.user.id) {
      throw new ForbiddenError("Only the owner can make a shared dashboard personal again");
    }
    const spec = await checkedSpec(ctx, {
      filters: input.filters ?? before.filters,
      widgets: input.widgets ?? before.widgets,
    });
    const after: Dashboard = {
      ...before,
      title: input.title ?? before.title,
      description: input.description === undefined ? before.description : input.description,
      shared: input.shared ?? before.shared,
      filters: spec.filters,
      widgets: spec.widgets,
      updatedAt: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_dashboards")
        .set({
          title: after.title,
          description: after.description,
          shared: after.shared ? 1 : 0,
          spec: JSON.stringify(spec),
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "dashboard",
      id: input.id,
      action: "update",
      before: snapshot(before),
      after: snapshot(after),
    });
    return after;
  },
});

export const dashboardDelete = defineOperation({
  name: "dashboard.delete",
  description:
    "Delete a dashboard you own (or, as an admin, a shared one). Only the dashboard goes; no " +
    "records are touched. Anyone whose Home it was gets the Overview again. Cannot be undone.",
  input: z.object({ id: dashboardId }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireEditable(ctx, input.id);
    await assertNotLocked(ctx, "dashboard", input.id);
    ctx.write(
      ctx.db.deleteFrom("core_dashboards").where("id", "=", input.id),
      ctx.db.deleteFrom("core_user_home").where("dashboard_id", "=", input.id),
    );
    ctx.recordChange({
      object: "dashboard",
      id: input.id,
      action: "delete",
      before: snapshot(before),
    });
    return { id: input.id, deleted: true as const };
  },
});

export const dashboardSetHome = defineOperation({
  name: "dashboard.setHome",
  description:
    "Make a dashboard you can open your Home, shown at /. Pass null to go back to the default " +
    "(see dashboard.home). Only changes your own Home.",
  input: z.object({ id: dashboardId.nullable() }),
  output: z.object({ homeId: z.string() }),
  permission: "records:read",
  risk: "write",
  async handler(input, ctx) {
    if (input.id === null) {
      ctx.write(ctx.db.deleteFrom("core_user_home").where("user_id", "=", ctx.user.id));
      return { homeId: defaultHomeId(await shippedDashboards(ctx.db)) };
    }
    await requireVisible(ctx, input.id);
    ctx.write(
      ctx.db
        .insertInto("core_user_home")
        .values({ user_id: ctx.user.id, dashboard_id: input.id, updated_at: ctx.now })
        .onConflict((oc) =>
          oc
            .column("user_id")
            .doUpdateSet({ dashboard_id: input.id as string, updated_at: ctx.now }),
        ),
    );
    return { homeId: input.id };
  },
});

// --- Widgets ---------------------------------------------------------------------------------

const widgetResultSchema = z.object({
  widgetId: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number(),
  truncated: z.boolean(),
  cached: z.boolean().describe("Served from the 60 s result cache"),
  cachedAt: z.string().describe("When the rows were read"),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .describe("The named parameters bound (for click-through $param placeholders)"),
  previous: z
    .object({
      rows: z.array(z.record(z.string(), z.unknown())),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    })
    .nullable()
    .describe("KPI widgets: the same query over the previous period"),
  views: z.array(z.string()),
});
export type WidgetRunResult = z.infer<typeof widgetResultSchema>;

const recordIdInput = z
  .string()
  .max(64)
  .nullish()
  .describe("On a record tab: the record's id, bound to :record_id");

export const widgetRun = defineOperation({
  name: "widget.run",
  description:
    "Run one widget of a dashboard you can open with its filters set to `filters` (defaults " +
    "apply to filters left out) and return its rows. Results are cached for 60 seconds per " +
    "query and params; refresh: true reads fresh data. KPI widgets also return the previous " +
    "period. Read-only.",
  input: z.object({
    dashboardId,
    widgetId: z.string().min(1).max(64),
    filters: filterValuesSchema,
    recordId: recordIdInput,
    refresh: z.boolean().default(false),
  }),
  output: widgetResultSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const dashboard = await requireVisible(ctx, input.dashboardId);
    const widget = dashboard.widgets.find((w) => w.id === input.widgetId);
    if (!widget) throw new NotFoundError("widget", input.widgetId);
    return runWidget(ctx, {
      widget,
      filters: dashboard.filters,
      values: input.filters,
      recordId: input.recordId ?? null,
      refresh: input.refresh,
    });
  },
});

export const widgetPreview = defineOperation({
  name: "widget.preview",
  description:
    "Run a widget spec without saving it, to check its SQL and see its rows: the same guards, " +
    "params, limits and cache as a saved widget. Pass the dashboard's filter definitions " +
    "(`dashboardFilters`) so their params bind, and `filters` for their values. Read-only.",
  input: z.object({
    widget: widgetSpecSchema,
    dashboardFilters: z.array(dashboardFilterSchema).max(8).default([]),
    filters: filterValuesSchema,
    recordId: recordIdInput,
    refresh: z.boolean().default(false),
  }),
  output: widgetResultSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    await validateDashboardSpec(ctx.db, {
      filters: input.dashboardFilters,
      widgets: [input.widget],
    });
    return runWidget(ctx, {
      widget: input.widget,
      filters: input.dashboardFilters,
      values: input.filters,
      recordId: input.recordId ?? null,
      refresh: input.refresh,
    });
  },
});

const describeOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    widget: widgetSpecSchema,
    preview: widgetResultSchema,
    model: z.string(),
    attempts: z.number(),
  }),
  z.object({
    status: z.literal("invalid"),
    message: z.string(),
    widget: widgetSpecSchema.nullable(),
    model: z.string(),
    attempts: z.number(),
  }),
  z.object({ status: z.literal("unavailable"), message: z.string() }),
]);

/** One model answer parsed into a widget, or the reason it could not be. */
function parseAnswer(text: string): { widget: WidgetSpec } | { error: string } {
  const json = extractJson(text);
  if (!json || typeof json !== "object") return { error: "The answer was not a JSON object" };
  const raw = json as Record<string, unknown>;
  const parsed = widgetSpecSchema.safeParse({
    ...raw,
    id:
      typeof raw.id === "string" && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(raw.id)
        ? raw.id
        : `w-${Math.random().toString(36).slice(2, 8)}`,
    mapping: raw.mapping ?? {},
    options: raw.options ?? {},
  });
  if (!parsed.success) {
    return {
      error: `The widget spec is invalid: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { widget: parsed.data };
}

export const widgetDescribe = defineOperation({
  name: "widget.describe",
  description:
    'Turn a plain-language description ("tasks by status as a bar chart") into a widget spec ' +
    "with the `build` model role, then validate and preview it. Nothing is saved. Says the AI " +
    "is not configured when the deployment has no model.",
  input: z.object({
    prompt: z.string().trim().min(3).max(4000),
    dashboardFilters: z.array(dashboardFilterSchema).max(8).default([]),
    filters: filterValuesSchema,
  }),
  output: describeOutput,
  permission: "records:read",
  risk: "read",
  // MCP clients are models themselves: they write widgets with widget.preview directly.
  mcp: { expose: false },
  async handler(input, ctx) {
    const models: ModelRunner | undefined = ctx.models;
    if (!models) {
      return {
        status: "unavailable" as const,
        message:
          "AI is not configured for this deployment: add an `ai` binding to ros-app " +
          "(docs/deploying.md). You can still build the widget by hand.",
      };
    }
    // widget.shape (docs/jev.md placement 6): the judge picks the shape from the prompt alone,
    // before generation. Advice: no pick (off, unclear, failed) changes nothing.
    const shape = ctx.judge ? await askShape(ctx.judge, input.prompt) : null;
    const pick: Exclude<Shape, "unclear"> | null = shape?.status === "answered" ? shape.pick : null;
    const messages = describePrompt(input.prompt, input.dashboardFilters);
    if (pick) {
      const last = messages.at(-1);
      if (last) last.content = `${last.content}\n\n(${shapeHint(pick)})`;
    }
    let lastError = "";
    let lastWidget: WidgetSpec | null = null;
    let model = "";
    // A valid widget whose type does not fit the pick, kept in case the retry does worse.
    let unfitting: { widget: WidgetSpec; preview: WidgetRunResult; model: string } | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let text: string;
      try {
        const answer = await models.run("build", messages, { maxTokens: 1200 });
        text = answer.text;
        model = answer.model;
      } catch (error) {
        throw new OperationError(
          "config",
          `The build model failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const parsed = parseAnswer(text);
      if ("widget" in parsed) {
        lastWidget = parsed.widget;
        try {
          await validateDashboardSpec(ctx.db, {
            filters: input.dashboardFilters,
            widgets: [parsed.widget],
          });
          const preview = await runWidget(ctx, {
            widget: parsed.widget,
            filters: input.dashboardFilters,
            values: input.filters,
          });
          // The shape check: one retry at most, and the second answer stands whatever its type.
          if (attempt === 1 && !typeFits(pick, parsed.widget.type)) {
            unfitting = { widget: parsed.widget, preview, model };
            lastError = shapeMismatch(pick as Exclude<Shape, "unclear">, parsed.widget.type);
          } else {
            return {
              status: "ok" as const,
              widget: parsed.widget,
              preview,
              model,
              attempts: attempt,
            };
          }
        } catch (error) {
          if (!(error instanceof OperationError)) throw error;
          lastError = error.message;
        }
      } else {
        lastError = parsed.error;
      }
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `That widget failed: ${lastError}. Reply with the corrected JSON object only.`,
        },
      );
    }
    // The retry did not give a valid widget: the first one was valid, only not the shape asked for.
    if (unfitting) return { status: "ok" as const, ...unfitting, attempts: 2 };
    return {
      status: "invalid" as const,
      message: lastError,
      widget: lastWidget,
      model,
      attempts: 2,
    };
  },
});

export const dashboardOperations = [
  dashboardList,
  dashboardGet,
  dashboardHome,
  dashboardCreate,
  dashboardUpdate,
  dashboardDelete,
  dashboardSetHome,
  widgetRun,
  widgetPreview,
  widgetDescribe,
] as const;
