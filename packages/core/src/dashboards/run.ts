// Running and validating widgets (ADR 0057). A data widget's SQL is bound (named → positional
// params), checked by the query.sql validator, and run with row and time limits through
// `runReadOnlySql`; results are cached for 60 s per query + params + visibility scope.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { Filter } from "../filter.ts";
import type { HandlerContext } from "../operation.ts";
import { runReadOnlySql, schemaObjectNames, validateReadOnlySql } from "../operations/query.ts";
import {
  cacheApiWidgetCache,
  visibilityScope,
  type WidgetCache,
  widgetCacheKey,
} from "./cache.ts";
import { bindNamedParams, type ParamValues, resolveParams } from "./params.ts";
import {
  allowedParamNames,
  type DashboardFilter,
  type DashboardSpec,
  type FilterValues,
  type WidgetSpec,
} from "./spec.ts";

export const WIDGET_LIMITS = { maxRows: 500, topN: 10, timeoutMs: 5000 } as const;

export interface WidgetResult {
  widgetId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  /** True when served from the 60 s cache. */
  cached: boolean;
  /** When the rows were read (ISO-8601). */
  cachedAt: string;
  /** The named parameters bound, for click-through `$param` placeholders. */
  params: ParamValues;
  /** KPI only: the same query over the previous period. */
  previous: { rows: Record<string, unknown>[]; params: ParamValues } | null;
  views: string[];
}

// sqlite_master, read at most once a minute per isolate: the validator needs every schema
// object name, and reading it on every widget run would cost a D1 query each time. A name
// created in the last minute is caught anyway by the reserved-prefix rule (core_, x_, …).
let schemaMemo: { names: Set<string>; at: number } | null = null;
async function schemaNames(db: Kysely<CoreDatabase>): Promise<Set<string>> {
  if (schemaMemo && Date.now() - schemaMemo.at < 60_000) return schemaMemo.names;
  const names = await schemaObjectNames(db);
  schemaMemo = { names, at: Date.now() };
  return names;
}
/** Forgets the memoised schema names (tests that create views). */
export function forgetSchemaNames(): void {
  schemaMemo = null;
}

function maxRowsFor(widget: WidgetSpec): number {
  if (widget.type === "kpi") return 2;
  if (widget.type === "table" || widget.type === "leaderboard") {
    return widget.options.limit ?? WIDGET_LIMITS.topN;
  }
  return WIDGET_LIMITS.maxRows;
}

/** True when the SQL reads one of the dashboard's date-range params. */
function usesDateRange(names: readonly string[], filters: readonly DashboardFilter[]): boolean {
  return filters.some(
    (f) => f.type === "dateRange" && (names.includes(`${f.id}_from`) || names.includes(`${f.id}_to`)),
  );
}

async function runCached(
  ctx: Pick<HandlerContext, "db" | "user" | "now">,
  cache: WidgetCache,
  bound: { sql: string; params: (string | number | null)[] },
  maxRows: number,
  refresh: boolean,
) {
  const key = await widgetCacheKey({
    sql: bound.sql,
    params: bound.params,
    maxRows,
    scope: visibilityScope(ctx.user),
  });
  type Stored = Awaited<ReturnType<typeof runReadOnlySql>>;
  if (!refresh) {
    const hit = await cache.get<Stored>(key);
    if (hit) return { result: hit.value, cached: true, cachedAt: hit.cachedAt };
  }
  const result = await runReadOnlySql(
    ctx.db,
    bound.sql,
    bound.params,
    { maxRows, timeoutMs: WIDGET_LIMITS.timeoutMs },
    await schemaNames(ctx.db),
  );
  const cachedAt = new Date().toISOString();
  await cache.put(key, result, cachedAt);
  return { result, cached: false, cachedAt };
}

/** Runs one widget with a dashboard's filters set to `values`. */
export async function runWidget(
  ctx: Pick<HandlerContext, "db" | "user" | "now" | "widgetCache">,
  options: {
    widget: WidgetSpec;
    filters: readonly DashboardFilter[];
    values: FilterValues;
    recordId?: string | null;
    refresh?: boolean;
  },
): Promise<WidgetResult> {
  const { widget, filters } = options;
  const resolved = resolveParams({
    filters,
    values: options.values,
    now: new Date(ctx.now),
    userId: ctx.user.id,
    recordId: options.recordId ?? null,
  });
  if (widget.type === "markdown" || !widget.sql) {
    return {
      widgetId: widget.id,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      cached: false,
      cachedAt: ctx.now,
      params: resolved.values,
      previous: null,
      views: [],
    };
  }
  const allowed = allowedParamNames(filters);
  const cache = ctx.widgetCache ?? cacheApiWidgetCache();
  const maxRows = maxRowsFor(widget);
  const bound = bindNamedParams(widget.sql, resolved.values, allowed);
  const current = await runCached(ctx, cache, bound, maxRows, options.refresh ?? false);

  let previous: WidgetResult["previous"] = null;
  if (
    widget.type === "kpi" &&
    widget.options.compare !== false &&
    resolved.previous &&
    usesDateRange(bound.names, filters)
  ) {
    const prevBound = bindNamedParams(widget.sql, resolved.previous, allowed);
    const prev = await runCached(ctx, cache, prevBound, maxRows, options.refresh ?? false);
    previous = { rows: prev.result.rows, params: resolved.previous };
  }
  return {
    widgetId: widget.id,
    columns: current.result.columns,
    rows: current.result.rows,
    rowCount: current.result.rowCount,
    truncated: current.result.truncated,
    cached: current.cached,
    cachedAt: current.cachedAt,
    params: resolved.values,
    previous,
    views: current.result.views,
  };
}

function walkFilterFields(filter: Filter, visit: (field: string) => void) {
  if ("and" in filter) for (const part of filter.and) walkFilterFields(part, visit);
  else if ("or" in filter) for (const part of filter.or) walkFilterFields(part, visit);
  else visit(filter.field);
}

/**
 * Checks a dashboard spec before it is saved: unique ids, known filter objects and fields, each
 * data widget's SQL binds and passes the query.sql guards (not run), and click-through templates
 * name real objects and fields.
 */
export async function validateDashboardSpec(
  db: Kysely<CoreDatabase>,
  spec: DashboardSpec,
): Promise<DashboardSpec> {
  const filterIds = new Set<string>();
  for (const filter of spec.filters) {
    if (filterIds.has(filter.id)) {
      throw new ValidationError(`Two filters are named ${filter.id}`, { field: "filters" });
    }
    filterIds.add(filter.id);
    if (filter.type === "field") {
      const object = getObject(filter.object);
      if (!object) {
        throw new ValidationError(`Filter ${filter.id}: unknown object ${filter.object}`, {
          field: "filters",
        });
      }
      if (!object.fields.some((f) => f.name === filter.field)) {
        throw new ValidationError(
          `Filter ${filter.id}: ${filter.object} has no field ${filter.field}`,
          { field: "filters" },
        );
      }
    }
  }
  const allowed = allowedParamNames(spec.filters);
  const names = await schemaNames(db);
  const widgetIds = new Set<string>();
  for (const widget of spec.widgets) {
    if (widgetIds.has(widget.id)) {
      throw new ValidationError(`Two widgets have the id ${widget.id}`, { field: "widgets" });
    }
    widgetIds.add(widget.id);
    try {
      if (widget.sql && widget.type !== "markdown") {
        const bound = bindNamedParams(widget.sql, {}, allowed);
        validateReadOnlySql(bound.sql, names);
      }
      if (widget.clickThrough) {
        const object = getObject(widget.clickThrough.object);
        if (!object) throw new ValidationError(`unknown object ${widget.clickThrough.object}`);
        if (widget.clickThrough.filter) {
          walkFilterFields(widget.clickThrough.filter, (field) => {
            if (!object.fields.some((f) => f.name === field)) {
              throw new ValidationError(`${object.name} has no field ${field}`);
            }
          });
        }
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(`Widget "${widget.title}" (${widget.id}): ${error.message}`, {
          field: "widgets",
          widgetId: widget.id,
          ...(typeof error.details === "object" && error.details ? error.details : {}),
        });
      }
      throw error;
    }
  }
  return spec;
}
