// Dashboard parameters (ADR 0057): dashboard filter values become named SQL parameters, and
// named parameters become the positional `?NNN` the query.sql validator and D1 accept.
//
// Date ranges always bind concrete ISO strings (all time is 0000… to 9999…), never NULL, so
// `created_at >= :date_from AND created_at < :date_to` stays an index range scan. `:now` is
// truncated to the minute so a widget's cache key holds for the 60 s cache window.
import { ValidationError } from "../errors.ts";
import { SqlRejectedError, tokenize } from "../operations/query.ts";
import {
  allowedParamNames,
  type DashboardFilter,
  type DatePreset,
  type FilterValue,
  type FilterValues,
} from "./spec.ts";

export type ParamValue = string | number | null;
export type ParamValues = Record<string, ParamValue>;

export const ALL_TIME = { from: "0000-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59.999Z" };

export interface DateWindow {
  from: string;
  to: string;
}

const DAY = 86_400_000;
const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const iso = (ms: number) => new Date(ms).toISOString();

/** The [from, to) window a preset or a { from, to } day range covers, in UTC. */
export function resolveDateWindow(value: FilterValue | undefined, now: Date): DateWindow | null {
  if (value && typeof value === "object") {
    const from = Date.parse(`${value.from}T00:00:00.000Z`);
    const to = Date.parse(`${value.to}T00:00:00.000Z`) + DAY;
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
      throw new ValidationError("A date range must end on or after its start", {
        field: "filters",
      });
    }
    return { from: iso(from), to: iso(to) };
  }
  const today = startOfDay(now);
  const tomorrow = today + DAY;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (value as DatePreset | null | undefined) {
    case "all_time":
    case null:
    case undefined:
      return null;
    case "today":
      return { from: iso(today), to: iso(tomorrow) };
    case "last_7_days":
      return { from: iso(tomorrow - 7 * DAY), to: iso(tomorrow) };
    case "last_30_days":
      return { from: iso(tomorrow - 30 * DAY), to: iso(tomorrow) };
    case "last_90_days":
      return { from: iso(tomorrow - 90 * DAY), to: iso(tomorrow) };
    case "last_365_days":
      return { from: iso(tomorrow - 365 * DAY), to: iso(tomorrow) };
    case "this_month":
      return { from: iso(Date.UTC(y, m, 1)), to: iso(Date.UTC(y, m + 1, 1)) };
    case "last_month":
      return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 1)) };
    case "this_quarter": {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(Date.UTC(y, q, 1)), to: iso(Date.UTC(y, q + 3, 1)) };
    }
    case "this_year":
      return { from: iso(Date.UTC(y, 0, 1)), to: iso(Date.UTC(y + 1, 0, 1)) };
    default:
      throw new ValidationError(`Unknown date range "${String(value)}"`, { field: "filters" });
  }
}

/**
 * The window just before `window`: calendar presets step back one unit (this month → last
 * month), rolling and custom ranges step back by their own length.
 */
export function previousWindow(value: FilterValue | undefined, window: DateWindow): DateWindow {
  const from = new Date(window.from);
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  switch (value) {
    case "this_month":
    case "last_month":
      return { from: iso(Date.UTC(y, m - 1, 1)), to: window.from };
    case "this_quarter":
      return { from: iso(Date.UTC(y, m - 3, 1)), to: window.from };
    case "this_year":
      return { from: iso(Date.UTC(y - 1, 0, 1)), to: window.from };
    default: {
      const length = Date.parse(window.to) - Date.parse(window.from);
      return { from: iso(Date.parse(window.from) - length), to: window.from };
    }
  }
}

export interface ResolvedParams {
  values: ParamValues;
  /** The previous period's values, when the dashboard has a bounded date range. */
  previous: ParamValues | null;
}

/** The value a filter is set to: the caller's, else the filter's default. */
function effectiveValue(filter: DashboardFilter, values: FilterValues): FilterValue {
  if (Object.hasOwn(values, filter.id)) return values[filter.id] ?? null;
  switch (filter.type) {
    case "dateRange":
      return filter.default;
    case "user":
      return filter.default === "me" ? "me" : null;
    default:
      return filter.default ?? null;
  }
}

/**
 * Binds a dashboard's filters (with the caller's values) and the system params. `me` resolves
 * to `userId`; a user filter set to "me" binds the caller's id.
 */
export function resolveParams(options: {
  filters: readonly DashboardFilter[];
  values: FilterValues;
  now: Date;
  userId: string;
  recordId?: string | null;
}): ResolvedParams {
  const { filters, values, now, userId } = options;
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const bound: ParamValues = {
    now: minute.toISOString(),
    today: minute.toISOString().slice(0, 10),
    me: userId,
    record_id: options.recordId ?? null,
  };
  let previous: ParamValues | null = null;
  for (const filter of filters) {
    const value = effectiveValue(filter, values);
    if (filter.type === "dateRange") {
      const window = resolveDateWindow(value, now);
      bound[`${filter.id}_from`] = window?.from ?? ALL_TIME.from;
      bound[`${filter.id}_to`] = window?.to ?? ALL_TIME.to;
      if (window) {
        const prev = previousWindow(value, window);
        previous ??= {};
        previous[`${filter.id}_from`] = prev.from;
        previous[`${filter.id}_to`] = prev.to;
      }
      continue;
    }
    if (value !== null && typeof value === "object") {
      throw new ValidationError(`Filter ${filter.id} takes a single value`, { field: "filters" });
    }
    bound[filter.id] = filter.type === "user" && value === "me" ? userId : (value ?? null);
  }
  return { values: bound, previous: previous ? { ...bound, ...previous } : null };
}

export interface BoundSql {
  /** The SQL with every named parameter replaced by `?N`. */
  sql: string;
  /** Positional values for ?1…?N. */
  params: ParamValue[];
  /** The named parameters the SQL uses, in first-use order. */
  names: string[];
}

/**
 * Rewrites named parameters (`:name`, `@name`, `$name`) to `?N` and returns the positional
 * values. Parameters outside `allowed` are refused; positional `?` parameters are refused
 * (widget SQL names its parameters). Strings, comments and quoted identifiers are left alone:
 * the rewrite works on query.sql's SQLite-faithful tokens.
 */
export function bindNamedParams(
  source: string,
  values: ParamValues,
  allowed: readonly string[],
): BoundSql {
  const tokens = tokenize(source);
  const names: string[] = [];
  let out = "";
  let at = 0;
  for (const token of tokens) {
    if (token.kind !== "param") continue;
    if (token.text.startsWith("?")) {
      throw new SqlRejectedError("widget SQL uses named parameters (:name), not ?", {
        at: token.start,
      });
    }
    const name = token.text.slice(1).toLowerCase();
    if (!allowed.includes(name)) {
      throw new SqlRejectedError(`unknown parameter :${name}`, {
        name,
        allowed: [...allowed],
      });
    }
    let index = names.indexOf(name);
    if (index < 0) {
      names.push(name);
      index = names.length - 1;
    }
    out += `${source.slice(at, token.start)}?${index + 1}`;
    at = token.start + token.text.length;
  }
  out += source.slice(at);
  return { sql: out, params: names.map((n) => values[n] ?? null), names };
}

/** The named parameters a widget on a dashboard with `filters` may use. */
export function widgetParamNames(filters: readonly DashboardFilter[]): string[] {
  return allowedParamNames(filters);
}
