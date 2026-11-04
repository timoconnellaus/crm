// List view state (view type, filter, sort, columns, layout) and its URL form. A list route
// validates its search params with `parseViewSearch`, and `useViewState` reads and writes them,
// so every list is shareable and survives reload and back/forward. The same state is what a
// saved view stores: a view spec (`table`, `board`, `calendar` or `gallery`, ADR 0056).
//
// URL form: `?filter=<filter JSON>&sort=displayName.desc&cols=displayName,primaryEmail&view=<id>`
// plus, for other view types, `&vt=board&layout=<layout JSON>`. Values equal to the list's
// defaults are left out so a fresh list has a clean URL.
import {
  type Filter,
  filterSchema,
  type ObjectDefinition,
  type ObjectViewType,
  type Sort,
} from "@crm/core/client";
import { useCallback, useMemo } from "react";

/** A new sort, or a function of the current one (e.g. a header click toggling direction). */
export type SortUpdate = Sort | ((current: Sort) => Sort);

/** The settings of the board, calendar and gallery view types (see views/spec.ts in core). */
export interface LayoutConfig {
  groupBy?: string;
  sumField?: string;
  columnOrder?: string[];
  dateField?: string;
  mode?: "month" | "week" | "agenda";
  imageField?: string;
  cardFields?: string[];
}

export interface ViewState {
  /** Table (default), board, calendar or gallery. */
  type: ObjectViewType;
  filter: Filter | undefined;
  sort: Sort;
  columns: string[];
  layout: LayoutConfig;
}

export interface ViewDefaults {
  sort: Sort;
  columns: readonly string[];
}

/** The search params a list route owns. */
export interface ViewSearch {
  filter?: Filter;
  sort?: string;
  cols?: string;
  /** Id of the saved view the state came from, if any. */
  view?: string;
  /** View type when not a table. */
  vt?: "board" | "calendar" | "gallery";
  /** Board, calendar or gallery settings. */
  layout?: LayoutConfig;
}

const VIEW_TYPES_IN_URL = ["board", "calendar", "gallery"] as const;
const LAYOUT_STRINGS = ["groupBy", "sumField", "dateField", "imageField"] as const;

/** Keeps the well-formed keys of a layout (a JSON string or an object). */
export function parseLayout(raw: unknown): LayoutConfig | undefined {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const layout: LayoutConfig = {};
  for (const key of LAYOUT_STRINGS) {
    const v = source[key];
    if (typeof v === "string" && v.length <= 80) layout[key] = v;
  }
  if (source.mode === "month" || source.mode === "week" || source.mode === "agenda") {
    layout.mode = source.mode;
  }
  for (const key of ["cardFields", "columnOrder"] as const) {
    const v = source[key];
    if (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string")) {
      layout[key] = v as string[];
    }
  }
  return Object.keys(layout).length ? layout : undefined;
}

function parseViewType(raw: unknown): ViewSearch["vt"] {
  return VIEW_TYPES_IN_URL.find((t) => t === raw);
}

function parseSort(object: ObjectDefinition, raw: unknown): Sort | undefined {
  if (typeof raw !== "string") return undefined;
  const [field, direction] = raw.split(".");
  if (direction !== "asc" && direction !== "desc") return undefined;
  const def = object.fields.find((f) => f.name === field);
  return def?.sortable ? { field: def.name, direction } : undefined;
}

function parseColumns(object: ObjectDefinition, raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const known = new Set(object.fields.map((f) => f.name));
  const cols = [...new Set(raw.split(",").filter((name) => known.has(name)))];
  return cols.length ? cols : undefined;
}

function parseFilter(raw: unknown): Filter | undefined {
  // Router search parsing already turns JSON into objects; accept a string too (hand-made links).
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const parsed = filterSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `validateSearch` for a list route: keeps only well-formed view params (unknown fields and
 * malformed JSON are dropped rather than breaking the page). Field-level filter checks happen in
 * the list operation, which reports them as an error state.
 */
export function parseViewSearch(
  object: ObjectDefinition,
  raw: Record<string, unknown>,
): ViewSearch {
  const search: ViewSearch = {};
  const filter = parseFilter(raw.filter);
  if (filter) search.filter = filter;
  if (parseSort(object, raw.sort)) search.sort = raw.sort as string;
  const cols = parseColumns(object, raw.cols);
  if (cols) search.cols = cols.join(",");
  if (typeof raw.view === "string" && raw.view.length <= 100) search.view = raw.view;
  const vt = parseViewType(raw.vt);
  if (vt) search.vt = vt;
  const layout = parseLayout(raw.layout);
  if (layout) search.layout = layout;
  return search;
}

/**
 * `validateSearch` for a list whose object is only known after loading (extension objects):
 * keeps well-formed params; sort and columns are checked against the object by
 * `searchToViewState` once it has loaded.
 */
export function parseViewSearchLoose(raw: Record<string, unknown>): ViewSearch {
  const search: ViewSearch = {};
  const filter = parseFilter(raw.filter);
  if (filter) search.filter = filter;
  if (typeof raw.sort === "string" && raw.sort.length <= 100) search.sort = raw.sort;
  if (typeof raw.cols === "string" && raw.cols.length <= 2000) search.cols = raw.cols;
  if (typeof raw.view === "string" && raw.view.length <= 100) search.view = raw.view;
  const vt = parseViewType(raw.vt);
  if (vt) search.vt = vt;
  const layout = parseLayout(raw.layout);
  if (layout) search.layout = layout;
  return search;
}

export function searchToViewState(
  object: ObjectDefinition,
  search: ViewSearch,
  defaults: ViewDefaults,
): ViewState {
  return {
    type: search.vt ?? "table",
    filter: search.filter,
    sort: parseSort(object, search.sort) ?? defaults.sort,
    columns: parseColumns(object, search.cols) ?? [...defaults.columns],
    layout: search.layout ?? {},
  };
}

const sameSort = (a: Sort, b: Sort) => a.field === b.field && a.direction === b.direction;
const sameColumns = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((col, i) => col === b[i]);

/** The search params for a state, leaving out anything equal to the defaults. */
export function viewStateToSearch(state: ViewState, defaults: ViewDefaults): ViewSearch {
  const search: ViewSearch = {};
  if (state.filter) search.filter = state.filter;
  if (!sameSort(state.sort, defaults.sort)) {
    search.sort = `${state.sort.field}.${state.sort.direction}`;
  }
  if (!sameColumns(state.columns, defaults.columns)) search.cols = state.columns.join(",");
  if (state.type !== "table") search.vt = state.type;
  if (state.type !== "table" && Object.keys(state.layout).length) search.layout = state.layout;
  return search;
}

export interface UseViewStateOptions<S extends ViewSearch> {
  object: ObjectDefinition;
  defaults: ViewDefaults;
  /** The route's current search params (`Route.useSearch()`). */
  search: S;
  /**
   * Writes new search params from the current ones, e.g.
   * `(update) => navigate({ search: update, replace: true })`. It takes an updater rather than a
   * value because two quick changes (a double click on a sortable header) can both happen before
   * the route re-renders with the first: the router resolves `update` against its latest
   * (pending) location, so the second change builds on the first instead of on stale props.
   */
  setSearch: (update: (current: S) => S) => void;
}

export interface ViewStateApi {
  state: ViewState;
  /** The saved view the state was loaded from, if the URL names one. */
  viewId: string | undefined;
  setFilter: (filter: Filter | undefined) => void;
  setSort: (sort: SortUpdate | undefined) => void;
  setColumns: (columns: string[]) => void;
  /** Switches the view type, with that type's settings. */
  setType: (type: ObjectViewType, layout?: LayoutConfig) => void;
  /** Changes the current view type's settings. */
  setLayout: (layout: LayoutConfig) => void;
  /** Replaces the whole state, e.g. from a saved view. */
  apply: (state: Partial<ViewState>, viewId?: string) => void;
  reset: () => void;
  /** True when anything differs from the defaults. */
  isDirty: boolean;
}

/** Reads and writes a list's view state in the URL. */
export function useViewState<S extends ViewSearch>({
  object,
  defaults,
  search,
  setSearch,
}: UseViewStateOptions<S>): ViewStateApi {
  const state = useMemo(
    () => searchToViewState(object, search, defaults),
    [object, search, defaults],
  );

  /** Writes the state `next` computes from the current URL's state (see `setSearch`). */
  const write = useCallback(
    (
      next: (current: ViewState) => ViewState,
      viewId: (current: string | undefined) => string | undefined = (current) => current,
    ) => {
      setSearch((current) => {
        // Keep params the route owns besides the view ones (e.g. a dialog flag).
        const { filter: _f, sort: _s, cols: _c, view: _v, vt: _t, layout: _l, ...rest } = current;
        const id = viewId(current.view);
        const view = viewStateToSearch(
          next(searchToViewState(object, current, defaults)),
          defaults,
        );
        return { ...rest, ...view, ...(id ? { view: id } : {}) } as S;
      });
    },
    [object, defaults, setSearch],
  );

  return {
    state,
    viewId: search.view,
    setFilter: (filter) => write((current) => ({ ...current, filter })),
    setSort: (sort) =>
      write((current) => ({
        ...current,
        sort: (typeof sort === "function" ? sort(current.sort) : sort) ?? defaults.sort,
      })),
    setColumns: (columns) => write((current) => ({ ...current, columns })),
    setType: (type, layout) =>
      write((current) => ({ ...current, type, layout: layout ?? current.layout })),
    setLayout: (layout) => write((current) => ({ ...current, layout })),
    apply: (partial, viewId) =>
      write(
        () => ({
          type: partial.type ?? "table",
          filter: partial.filter,
          sort: partial.sort ?? defaults.sort,
          columns: partial.columns ?? [...defaults.columns],
          layout: partial.layout ?? {},
        }),
        () => viewId,
      ),
    reset: () =>
      write(
        () => ({
          type: "table",
          filter: undefined,
          sort: defaults.sort,
          columns: [...defaults.columns],
          layout: {},
        }),
        () => undefined,
      ),
    isDirty: Object.keys(viewStateToSearch(state, defaults)).length > 0,
  };
}
