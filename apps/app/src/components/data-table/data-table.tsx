// A list table over any object in the field registry, fed by a `<object>.list` operation.
//
// - Infinite scroll: pages come from the operation's keyset cursor (useInfiniteQuery); the next
//   page is fetched when the rendered range nears the end, one request in flight at a time.
// - Virtualised rows (TanStack Virtual): only the rows in view (plus overscan) are in the DOM, so
//   6,000 people scroll smoothly with a bounded node count.
// - The table is its own scroll region (both axes) filling the page body: the header row is
//   sticky at the top, and the first column (with the select box) is sticky on the left when
//   the table scrolls sideways at narrow widths.
// - Server-driven sort, a column picker (the caller's), multi-select that persists while
//   scrolling and can extend to every matching record (up to SELECT_ALL_CAP, for the batch
//   operations), keyboard navigation (j/k move and scroll, x selects, Enter opens), scroll
//   restoration per history entry, and skeleton, error and empty states.
import type { FieldDefinition, Filter, ObjectDefinition, Sort } from "@crm/core/client";
import { getField } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, SearchXIcon } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useHotkey } from "#/lib/hotkeys";
import { errorMessage } from "#/lib/query";
import { recallScroll, useScrollKey, useScrollMemory } from "#/lib/scroll-memory";
import { PendingPopover, usePendingForRows } from "../approvals/pending-badge.tsx";
import { EmptyState, ErrorState } from "../empty-state.tsx";
import { DefaultCell } from "./cells.tsx";

/** What the table asks a list operation for (a subset of `listInputSchema`). */
export interface ListPageRequest {
  filter?: Filter;
  sort: Sort;
  cursor?: string;
  limit: number;
  fields: string[];
}

export interface ListPage<Row> {
  items: Row[];
  nextCursor: string | null;
}

export interface BulkActionContext<Row> {
  /** Selected rows that are loaded. */
  selected: Row[];
  /** Every selected id, loaded or not ("select all matching" selects rows not yet loaded). */
  ids: string[];
  /** Clears the selection (call after the action finishes). */
  clear: () => void;
}

/** The most records "Select all matching" selects: ten calls of a batch operation. */
export const SELECT_ALL_CAP = 1000;
/** Estimated row height; rows are measured once rendered. */
export const ROW_HEIGHT = 41;
/** Fetch the next page when the rendered range is this close to the end. */
const PREFETCH_ROWS = 25;
/** The sticky header row: h-10 plus its bottom border. */
const HEADER_HEIGHT = 41;
const DEFAULT_PAGE_SIZE = 50;

/** The fields a list fetches: the visible columns it can return plus `extraFields`. */
export function listFields(
  object: ObjectDefinition,
  columns: readonly string[],
  availableColumns: readonly string[],
  extraFields: readonly string[] = [],
): { visible: FieldDefinition[]; fields: string[] } {
  const visible = columns
    .map((name) => getField(object, name))
    .filter((f): f is FieldDefinition => Boolean(f) && availableColumns.includes(f?.name ?? ""));
  return { visible, fields: [...new Set([...visible.map((f) => f.name), ...extraFields])] };
}

/**
 * The infinite query behind a DataTable, shared with route loaders that prefetch the first page
 * on hover (intent preloading).
 */
export function listQueryOptions<Row>({
  queryKey,
  fetchPage,
  filter,
  sort,
  fields,
  pageSize = DEFAULT_PAGE_SIZE,
}: {
  queryKey: readonly unknown[];
  fetchPage: (request: ListPageRequest) => Promise<ListPage<Row>>;
  filter: Filter | undefined;
  sort: Sort;
  fields: string[];
  pageSize?: number;
}) {
  return infiniteQueryOptions({
    queryKey: [...queryKey, { filter: filter ?? null, sort, fields, limit: pageSize }],
    queryFn: ({ pageParam }) =>
      fetchPage({
        ...(filter ? { filter } : {}),
        sort,
        limit: pageSize,
        fields,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ListPage<Row>) => last.nextCursor ?? undefined,
  });
}

export interface DataTableProps<Row extends { id: string }> {
  /** Field registry entry: labels, types and which fields are sortable. */
  object: ObjectDefinition;
  /** Accessible name of the table, e.g. "People". */
  label: string;
  /** Cache key prefix for this list, e.g. `["op", "person.list", "table"]`. */
  queryKey: readonly unknown[];
  /** Fetches one page, e.g. `(input) => callOp("person.list", input)`. */
  fetchPage: (request: ListPageRequest) => Promise<ListPage<Row>>;
  /** Visible columns (field names), in order. */
  columns: readonly string[];
  /** Field names the list operation returns; other columns are ignored. Pair with ColumnPicker. */
  availableColumns: readonly string[];
  /** Extra fields to fetch for renderers (e.g. `organisationId` for a link). */
  extraFields?: readonly string[];
  sort: Sort;
  /** Called with an updater from the current sort (a `useState` setter fits). */
  onSortChange: (update: (current: Sort) => Sort) => void;
  filter?: Filter;
  /** Matching records in all (record.count), for "select all matching" and screen readers. */
  total?: { count: number; capped: boolean } | undefined;
  /** Custom cell renderers by field name; others use DefaultCell (by field type). */
  renderCell?: Partial<Record<string, (row: Row) => ReactNode>>;
  /** Opens a row (Enter on the active row). */
  onOpen?: (row: Row) => void;
  /** Rendered in a toolbar while rows are selected. */
  bulkActions?: (context: BulkActionContext<Row>) => ReactNode;
  /** Shown when there are no rows and no filter. */
  empty?: ReactNode;
  pageSize?: number;
  /** Keyboard navigation on (default true). Turn off for a second table on the page. */
  keyboard?: boolean;
  /**
   * Show a "Pending" badge on rows with changes waiting for approval: the registry object name,
   * looked up with approval.pendingForRecord once per page.
   */
  pendingObject?: string;
}

/** Column widths: grid tracks by field type, so every (absolutely positioned) row lines up. */
function track(field: FieldDefinition, first: boolean): { min: number; css: string } {
  if (first) return { min: 240, css: "minmax(240px,2fr)" };
  if (field.name === "tags" || field.related) return { min: 200, css: "minmax(200px,1.2fr)" };
  switch (field.type) {
    case "date":
    case "datetime":
      return { min: 150, css: "minmax(150px,0.8fr)" };
    case "number":
    case "boolean":
      return { min: 110, css: "minmax(110px,0.6fr)" };
    case "enum":
    case "id":
      return { min: 150, css: "minmax(150px,0.8fr)" };
    default:
      return { min: 200, css: "minmax(200px,1.2fr)" };
  }
}

const SELECT_WIDTH = 44;

export function DataTable<Row extends { id: string }>({
  object,
  label,
  queryKey,
  fetchPage,
  columns,
  availableColumns,
  extraFields = [],
  sort,
  onSortChange,
  filter,
  total,
  renderCell = {},
  onOpen,
  bulkActions,
  empty,
  pageSize = DEFAULT_PAGE_SIZE,
  keyboard = true,
  pendingObject,
}: DataTableProps<Row>) {
  const { visible, fields } = useMemo(
    () => listFields(object, columns, availableColumns, extraFields),
    [object, columns, availableColumns, extraFields],
  );

  const query = useInfiniteQuery({
    ...listQueryOptions({ queryKey, fetchPage, filter, sort, fields, pageSize }),
    placeholderData: (previous) => previous,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const pageRows = useMemo(() => query.data?.pages.map((p) => p.items) ?? [], [query.data]);
  const pending = usePendingForRows(pendingObject, pageRows);
  const { hasNextPage, isFetching, fetchNextPage, isFetchNextPageError } = query;

  // Selection is a set of ids, so it survives scrolling and rows loading or unloading.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [active, setActive] = useState(-1);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, []);

  // --- Scrolling and virtualisation -----------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = useScrollKey(`list:${label}`);
  useScrollMemory(scrollRef, `list:${label}`, { ready: rows.length > 0 });
  const loaderRow = hasNextPage ? 1 : 0;
  const virtualizer = useVirtualizer({
    count: rows.length + loaderRow,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? `loader-${index}`,
    initialOffset: () => recallScroll(scrollKey) ?? 0,
    // The rows start below the sticky header row, inside the same scroller; scrolling to a row
    // (j/k) keeps it clear of the header.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index ?? -1;

  // Infinite load: near the end of what is loaded, fetch the next page. `isFetching` covers both
  // next-page and background refetches, so there is never more than one request in flight.
  useEffect(() => {
    // After a failed page, wait for "Try again" rather than retrying in a loop.
    if (lastIndex < 0 || !hasNextPage || isFetching || isFetchNextPageError) return;
    if (lastIndex >= rows.length - PREFETCH_ROWS) void fetchNextPage({ cancelRefetch: false });
  }, [lastIndex, rows.length, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);

  // A new filter or sort is a new result set: clear the selection and cursor, back to the top.
  // (Not on mount, which would undo scroll restoration.)
  const resetKey = JSON.stringify([filter ?? null, sort]);
  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    clearSelection();
    setActive(-1);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey, clearSelection]);

  // --- Keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    if (active >= 0) virtualizer.scrollToIndex(active, { align: "auto" });
  }, [active, virtualizer]);

  const move = (delta: number) =>
    setActive((i) => Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + delta)));
  useHotkey("j", () => move(1), { enabled: keyboard && rows.length > 0 });
  useHotkey("k", () => move(-1), { enabled: keyboard && rows.length > 0 });
  useHotkey(
    "enter",
    () => {
      const row = rows[active];
      if (row && onOpen) onOpen(row);
    },
    { enabled: keyboard && active >= 0 && Boolean(onOpen) },
  );
  useHotkey(
    "x",
    () => {
      const row = rows[active];
      if (row) toggle(row.id);
    },
    { enabled: keyboard && active >= 0 && Boolean(bulkActions) },
  );

  function toggle(id: string) {
    setAllMatching(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Selects every matching record (up to SELECT_ALL_CAP) by paging ids from the operation. */
  async function selectAllMatching() {
    setSelectingAll(true);
    try {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchPage({
          ...(filter ? { filter } : {}),
          sort,
          limit: 200,
          fields: [],
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor && ids.length < SELECT_ALL_CAP);
      setSelected(new Set(ids.slice(0, SELECT_ALL_CAP)));
      setAllMatching(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSelectingAll(false);
    }
  }

  const loadedSelected = useMemo(
    () => rows.filter((row) => selected.has(row.id)),
    [rows, selected],
  );
  const allLoadedSelected = rows.length > 0 && loadedSelected.length === rows.length;
  const someSelected = selected.size > 0 && !allLoadedSelected;
  const selectable = Boolean(bulkActions);
  const matching = total?.count;
  const canSelectMore =
    allLoadedSelected && !allMatching && (hasNextPage || (matching ?? 0) > rows.length);

  function onHeaderClick(field: FieldDefinition) {
    if (!field.sortable) return;
    // Toggle against the current sort when the change applies, not the rendered `sort`: a second
    // quick click can land before the parent re-renders with the first one's result.
    onSortChange((current) =>
      current.field !== field.name
        ? { field: field.name, direction: "asc" }
        : { field: field.name, direction: current.direction === "asc" ? "desc" : "asc" },
    );
  }

  // --- Layout -----------------------------------------------------------------------------------
  const tracks = visible.map((field, i) => track(field, i === 0));
  const gridTemplateColumns = [
    ...(selectable ? [`${SELECT_WIDTH}px`] : []),
    ...tracks.map((t) => t.css),
  ].join(" ");
  const minWidth = tracks.reduce((sum, t) => sum + t.min, selectable ? SELECT_WIDTH : 0);
  const rowStyle: CSSProperties = { gridTemplateColumns };
  // Sticky cells need an opaque background that follows the row's state.
  const stickyCell =
    "sticky z-[1] bg-background group-hover/row:bg-muted group-data-[state=selected]/row:bg-muted group-data-[active]/row:bg-accent";
  const firstLeft = selectable ? SELECT_WIDTH : 0;

  const showEmpty = query.isSuccess && rows.length === 0;
  const selectedCount = selected.size;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-table-region">
      {selectable && selectedCount > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/60 px-4 py-2 text-sm sm:px-6"
          role="toolbar"
          aria-label="Bulk actions"
          data-testid="bulk-actions"
        >
          <span className="font-medium" data-testid="selected-count">
            {allMatching
              ? `All ${selectedCount.toLocaleString()} matching selected`
              : `${selectedCount.toLocaleString()} selected`}
          </span>
          {canSelectMore && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-1"
              onClick={() => void selectAllMatching()}
              disabled={selectingAll}
              data-testid="select-all-matching"
            >
              {selectingAll
                ? "Selecting…"
                : matching !== undefined && matching <= SELECT_ALL_CAP && !total?.capped
                  ? `Select all ${matching.toLocaleString()} matching`
                  : `Select the first ${SELECT_ALL_CAP.toLocaleString()} matching`}
            </Button>
          )}
          <div className="flex-1" />
          {bulkActions?.({
            selected: loadedSelected,
            ids: [...selected],
            clear: clearSelection,
          })}
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
        data-testid="data-table-scroll"
      >
        <table
          aria-label={label}
          aria-busy={query.isFetching}
          aria-rowcount={matching !== undefined && !total?.capped ? matching + 1 : -1}
          data-testid="data-table"
          className={cn(
            "grid w-full text-sm transition-opacity",
            query.isPlaceholderData && "opacity-60",
          )}
          style={{ minWidth }}
        >
          <thead className="sticky top-0 z-20 grid bg-background">
            <tr className="grid border-b" style={rowStyle} aria-rowindex={1}>
              {selectable && (
                <th
                  className="sticky left-0 z-[2] flex h-10 items-center bg-background pl-4"
                  scope="col"
                >
                  <Checkbox
                    aria-label="Select all loaded rows"
                    checked={allLoadedSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(checked) => {
                      setAllMatching(false);
                      setSelected(checked ? new Set(rows.map((row) => row.id)) : new Set());
                    }}
                  />
                </th>
              )}
              {visible.map((field, column) => {
                const sorted = sort.field === field.name ? sort.direction : null;
                return (
                  <th
                    key={field.name}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                    className={cn(
                      "flex h-10 min-w-0 items-center px-3 text-left font-medium whitespace-nowrap text-muted-foreground",
                      column === 0 && "sticky z-[2] bg-background shadow-[1px_0_0_var(--border)]",
                      column === 0 && !selectable && "pl-4 sm:pl-6",
                    )}
                    style={column === 0 ? { left: firstLeft } : undefined}
                  >
                    {field.sortable ? (
                      <button
                        type="button"
                        className="-mx-2 inline-flex min-w-0 items-center gap-1 rounded px-2 py-1 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={() => onHeaderClick(field)}
                      >
                        <span className="truncate">{field.label}</span>
                        {sorted === "asc" ? (
                          <ArrowUpIcon className="size-3.5 shrink-0" aria-hidden />
                        ) : sorted === "desc" ? (
                          <ArrowDownIcon className="size-3.5 shrink-0" aria-hidden />
                        ) : (
                          <ArrowUpDownIcon className="size-3.5 shrink-0 opacity-40" aria-hidden />
                        )}
                        <span className="sr-only">
                          {sorted ? `, sorted ${sorted}ending` : ", sortable"}
                        </span>
                      </button>
                    ) : (
                      <span className="truncate">{field.label}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          {query.isPending ? (
            <tbody className="grid">
              {Array.from({ length: 12 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows.
                <tr key={i} className="grid border-b" style={rowStyle} data-testid="row-skeleton">
                  {selectable && (
                    <td className="flex h-10 items-center pl-4">
                      <Skeleton className="size-4" />
                    </td>
                  )}
                  {visible.map((field) => (
                    <td key={field.name} className="flex h-10 items-center px-3">
                      <Skeleton className="h-4 w-full max-w-40" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : (
            <tbody
              className="relative grid"
              style={{ height: rows.length ? virtualizer.getTotalSize() : undefined }}
            >
              {virtualRows.map((item) => {
                const row = rows[item.index];
                const style: CSSProperties = {
                  ...rowStyle,
                  transform: `translateY(${item.start - HEADER_HEIGHT}px)`,
                };
                if (!row) {
                  return (
                    <tr
                      key={item.key}
                      ref={virtualizer.measureElement}
                      data-index={item.index}
                      className="absolute inset-x-0 top-0 grid border-b"
                      style={style}
                      data-testid="row-loading"
                      aria-hidden
                    >
                      {selectable && <td className="h-10" />}
                      {visible.map((field) => (
                        <td key={field.name} className="flex h-10 items-center px-3">
                          <Skeleton className="h-4 w-full max-w-32" />
                        </td>
                      ))}
                    </tr>
                  );
                }
                const isSelected = selected.has(row.id);
                const isActive = item.index === active;
                return (
                  <tr
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    data-active={isActive || undefined}
                    data-state={isSelected ? "selected" : undefined}
                    aria-selected={selectable ? isSelected : undefined}
                    aria-rowindex={item.index + 2}
                    className="group/row absolute inset-x-0 top-0 grid border-b hover:bg-muted data-[active]:bg-accent data-[active]:outline-2 data-[active]:-outline-offset-2 data-[active]:outline-ring/50 data-[state=selected]:bg-muted"
                    style={style}
                    onClick={() => setActive(item.index)}
                    onDoubleClick={() => onOpen?.(row)}
                  >
                    {selectable && (
                      <td className={cn("left-0 flex min-h-10 items-center pl-4", stickyCell)}>
                        <Checkbox
                          aria-label="Select row"
                          checked={isSelected}
                          onCheckedChange={() => toggle(row.id)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                    )}
                    {visible.map((field, column) => {
                      const content = renderCell[field.name]?.(row) ?? (
                        <DefaultCell
                          field={field}
                          value={(row as Record<string, unknown>)[field.name]}
                        />
                      );
                      const waiting = column === 0 ? pending.get(row.id) : undefined;
                      return (
                        <td
                          key={field.name}
                          className={cn(
                            "flex min-h-10 min-w-0 items-center px-3 py-2",
                            column === 0 && [stickyCell, "shadow-[1px_0_0_var(--border)]"],
                            column === 0 && !selectable && "pl-4 sm:pl-6",
                          )}
                          style={column === 0 ? { left: firstLeft } : undefined}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="min-w-0 truncate">{content}</div>
                            {waiting && <PendingPopover items={waiting} compact />}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
        {query.isError && !rows.length && (
          <div className="p-4 sm:p-6">
            <ErrorState
              title={`Could not load ${label.toLowerCase()}`}
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          </div>
        )}
        {showEmpty && (
          <div className="p-4 sm:p-6">
            {filter ? (
              <EmptyState
                icon={SearchXIcon}
                title="No matches"
                description="Nothing matches this filter. Change or clear it."
              />
            ) : (
              (empty ?? <EmptyState title={`No ${label.toLowerCase()} yet`} />)
            )}
          </div>
        )}
      </div>
      {isFetchNextPageError && (
        <div
          className="flex shrink-0 items-center gap-2 border-t px-4 py-2 text-sm sm:px-6"
          role="alert"
        >
          <span className="text-destructive">Could not load more: {errorMessage(query.error)}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void fetchNextPage({ cancelRefetch: false })}
          >
            Try again
          </Button>
        </div>
      )}
      <p className="sr-only" aria-live="polite" data-testid="data-table-status">
        {query.isSuccess
          ? `${rows.length.toLocaleString()} of ${
              matching !== undefined
                ? `${matching.toLocaleString()}${total?.capped ? "+" : ""}`
                : `${rows.length}${hasNextPage ? "+" : ""}`
            } ${label.toLowerCase()} loaded`
          : ""}
      </p>
    </div>
  );
}
