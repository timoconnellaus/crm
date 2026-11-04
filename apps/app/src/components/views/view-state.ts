// List view state (filter, sort, columns) and its URL form. A list route validates its search
// params with `parseViewSearch`, and `useViewState` reads and writes them, so every list is
// shareable and survives reload and back/forward. The same state is what a saved view stores
// (`{ object, filter, sort, columns }`, a stage-4 `table` view spec).
//
// URL form: `?filter=<filter JSON>&sort=displayName.desc&cols=displayName,primaryEmail&view=<id>`.
// Values equal to the list's defaults are left out so a fresh list has a clean URL.
import { type Filter, filterSchema, type ObjectDefinition, type Sort } from "@crm/core/client";
import { useCallback, useMemo } from "react";

/** A new sort, or a function of the current one (e.g. a header click toggling direction). */
export type SortUpdate = Sort | ((current: Sort) => Sort);

export interface ViewState {
  filter: Filter | undefined;
  sort: Sort;
  columns: string[];
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
  return search;
}

export function searchToViewState(
  object: ObjectDefinition,
  search: ViewSearch,
  defaults: ViewDefaults,
): ViewState {
  return {
    filter: search.filter,
    sort: parseSort(object, search.sort) ?? defaults.sort,
    columns: parseColumns(object, search.cols) ?? [...defaults.columns],
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
        const { filter: _f, sort: _s, cols: _c, view: _v, ...rest } = current;
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
    apply: (partial, viewId) =>
      write(
        () => ({
          filter: partial.filter,
          sort: partial.sort ?? defaults.sort,
          columns: partial.columns ?? [...defaults.columns],
        }),
        () => viewId,
      ),
    reset: () =>
      write(
        () => ({ filter: undefined, sort: defaults.sort, columns: [...defaults.columns] }),
        () => undefined,
      ),
    isDirty: Object.keys(viewStateToSearch(state, defaults)).length > 0,
  };
}
