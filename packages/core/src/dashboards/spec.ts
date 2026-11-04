// The dashboard spec (ADR 0027, ADR 0057): filters, and widgets laid out on a 12-column grid.
// Data widgets carry read-only SQL over the crm_* views with named parameters (`:date_from`,
// `:owner`, …) bound from the dashboard's filters; a chart mapping says which result columns
// are x, y, series and value; a click-through template turns a clicked row into list filter
// JSON. Browser-safe: no database imports.
import { z } from "zod";
import { filterSchema } from "../filter.ts";

export const WIDGET_TYPES = [
  "kpi",
  "bar",
  "line",
  "donut",
  "funnel",
  "table",
  "leaderboard",
  "markdown",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Widget types that run SQL (everything but markdown). */
export const DATA_WIDGET_TYPES: readonly WidgetType[] = WIDGET_TYPES.filter(
  (t) => t !== "markdown",
);

export const DATE_PRESETS = [
  "all_time",
  "today",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_365_days",
  "this_month",
  "last_month",
  "this_quarter",
  "this_year",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

const paramName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,30}$/, "lowercase letters, digits and _; starts with a letter");

const filterBase = {
  id: paramName.describe(
    "The filter's id, which names its SQL parameter(s): a dateRange `date` binds :date_from and " +
      ":date_to; any other filter `owner` binds :owner",
  ),
  label: z.string().min(1).max(100),
};

export const dashboardFilterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dateRange"),
    ...filterBase,
    default: z.enum(DATE_PRESETS).default("last_90_days"),
  }),
  z.object({
    type: z.literal("user"),
    ...filterBase,
    default: z.enum(["me", "anyone"]).default("anyone"),
  }),
  z.object({
    type: z.literal("select"),
    ...filterBase,
    options: z
      .array(z.object({ value: z.string().max(200), label: z.string().max(200) }))
      .min(1)
      .max(100),
    default: z.string().max(200).nullish(),
  }),
  z.object({
    type: z.literal("field"),
    ...filterBase,
    object: z.string().min(1).max(80).describe("Object whose field supplies the choices"),
    field: z.string().min(1).max(80).describe("A select field (choices) or any text field"),
    default: z.string().max(200).nullish(),
  }),
  z.object({
    type: z.literal("text"),
    ...filterBase,
    default: z.string().max(200).nullish(),
  }),
]);
export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;

/** The value a dashboard filter is set to when a widget runs. */
export const filterValueSchema = z.union([
  z.enum(DATE_PRESETS),
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.string().max(200),
  z.null(),
]);
export type FilterValue = z.infer<typeof filterValueSchema>;
export const filterValuesSchema = z
  .record(z.string().max(31), filterValueSchema)
  .default({})
  .describe(
    "Dashboard filter values by filter id: a date preset or { from, to } (YYYY-MM-DD, inclusive) " +
      "for dateRange filters, a user id / 'me' / null for user filters, a value or null otherwise",
  );
export type FilterValues = z.infer<typeof filterValuesSchema>;

export const widgetMappingSchema = z
  .object({
    x: z.string().max(80).optional().describe("Category or time column (bar, line, funnel)"),
    y: z
      .union([z.string().max(80), z.array(z.string().max(80)).min(1).max(8)])
      .optional()
      .describe("Value column(s) (bar, line)"),
    series: z
      .string()
      .max(80)
      .optional()
      .describe("A column whose values split rows into series (long format, bar/line)"),
    label: z
      .string()
      .max(80)
      .optional()
      .describe("Segment or row label column (donut, leaderboard)"),
    value: z.string().max(80).optional().describe("Value column (kpi, donut, funnel, leaderboard)"),
    columns: z.array(z.string().max(80)).max(20).optional().describe("Columns shown (table)"),
  })
  .default({});
export type WidgetMapping = z.infer<typeof widgetMappingSchema>;

export const widgetOptionsSchema = z
  .object({
    orientation: z.enum(["vertical", "horizontal"]).optional().describe("bar: columns or bars"),
    stacked: z.boolean().optional(),
    area: z.boolean().optional().describe("line: fill as an area chart"),
    pie: z.boolean().optional().describe("donut: a full pie instead of a ring"),
    format: z.enum(["number", "currency", "percent"]).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    compare: z
      .boolean()
      .optional()
      .describe("kpi: compare with the previous period of the date filter (default true)"),
    limit: z.number().int().min(1).max(100).optional().describe("table/leaderboard: top N rows"),
  })
  .default({});
export type WidgetOptions = z.infer<typeof widgetOptionsSchema>;

/**
 * A click-through: the list to open when a chart segment, KPI or row is clicked. Values in
 * `filter` may be placeholders: `{ "$row": "<column>" }` (the clicked row's value) or
 * `{ "$param": "<name>" }` (a bound SQL parameter, e.g. `date_from`). A condition whose
 * placeholder resolves to null is left out, so an unset filter does not narrow the list.
 */
export const clickThroughSchema = z.object({
  object: z.string().min(1).max(80).describe("The object whose list opens"),
  objectColumn: z
    .string()
    .max(80)
    .nullish()
    .describe("A result column naming the object per row, when rows mix objects"),
  filter: filterSchema.nullish(),
});
export type ClickThrough = z.infer<typeof clickThroughSchema>;

export const widgetLayoutSchema = z
  .object({
    w: z.number().int().min(1).max(12).default(6).describe("Width in grid columns (of 12)"),
    h: z.number().int().min(1).max(8).default(2).describe("Height in grid rows (about 9rem each)"),
  })
  .default({ w: 6, h: 2 });

export const widgetSpecSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/)
      .describe("Stable id within the dashboard, e.g. people-added"),
    type: z.enum(WIDGET_TYPES),
    title: z.string().min(1).max(200),
    description: z.string().max(1000).nullish(),
    sql: z
      .string()
      .max(20_000)
      .nullish()
      .describe(
        "Data widgets: one read-only SELECT over crm_* views. Use named params for filters " +
          "(:date_from, :date_to, :owner, …) and the system params :now, :today and :me",
      ),
    markdown: z.string().max(20_000).nullish().describe("Markdown widgets: the text"),
    mapping: widgetMappingSchema,
    options: widgetOptionsSchema,
    clickThrough: clickThroughSchema.nullish(),
    layout: widgetLayoutSchema,
  })
  .superRefine((widget, ctx) => {
    if (widget.type === "markdown") {
      if (!widget.markdown?.trim()) {
        ctx.addIssue({ code: "custom", path: ["markdown"], message: "markdown widgets need text" });
      }
    } else if (!widget.sql?.trim()) {
      ctx.addIssue({ code: "custom", path: ["sql"], message: `${widget.type} widgets need sql` });
    }
  });
export type WidgetSpec = z.infer<typeof widgetSpecSchema>;
export type WidgetSpecInput = z.input<typeof widgetSpecSchema>;

export const dashboardSpecSchema = z.object({
  filters: z.array(dashboardFilterSchema).max(8).default([]),
  widgets: z.array(widgetSpecSchema).max(30).default([]),
});
export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;
export type DashboardSpecInput = z.input<typeof dashboardSpecSchema>;

/** Parameters every widget can use, besides its dashboard's filters. */
export const SYSTEM_PARAMS = {
  now: "The current time (ISO-8601 UTC, to the minute)",
  today: "Today's date (YYYY-MM-DD, UTC)",
  me: "The id of the user viewing the dashboard",
  record_id: "On a record tab or panel: the record's id (null elsewhere)",
} as const;

/** The named parameters a dashboard's filters bind. */
export function filterParamNames(filters: readonly DashboardFilter[]): string[] {
  return filters.flatMap((f) => (f.type === "dateRange" ? [`${f.id}_from`, `${f.id}_to`] : [f.id]));
}

/** Every parameter name a widget on a dashboard with `filters` may use. */
export function allowedParamNames(filters: readonly DashboardFilter[]): string[] {
  return [...Object.keys(SYSTEM_PARAMS), ...filterParamNames(filters)];
}
