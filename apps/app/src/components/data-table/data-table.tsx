// A list table over any object in the field registry, fed by a `<object>.list` operation:
// server-driven sort and keyset (cursor) pagination, a column picker, multi-select rows with a
// bulk-action slot, keyboard navigation (j/k to move, x to select, Enter to open), and loading,
// error and empty states. Filtering is the caller's (pass `filter`); see FilterBuilder.
import type { FieldDefinition, Filter, ObjectDefinition, Sort } from "@crm/core/client";
import { getField } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Skeleton } from "@crm/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@crm/ui/components/table";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, SearchXIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useHotkey } from "#/lib/hotkeys";
import { errorMessage } from "#/lib/query";
import { EmptyState } from "../empty-state.tsx";
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
  selected: Row[];
  /** Clears the selection (call after the action finishes). */
  clear: () => void;
}

export interface DataTableProps<Row extends { id: string }> {
  /** Field registry entry: labels, types and which fields are sortable. */
  object: ObjectDefinition;
  /** Accessible name of the table, e.g. "People". */
  label: string;
  /** Cache key prefix for this list, e.g. `["op", "person.list"]`. */
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
}

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
  renderCell = {},
  onOpen,
  bulkActions,
  empty,
  pageSize = 50,
  keyboard = true,
}: DataTableProps<Row>) {
  const visible = useMemo(
    () =>
      columns
        .map((name) => getField(object, name))
        .filter(
          (f): f is FieldDefinition => Boolean(f) && availableColumns.includes(f?.name ?? ""),
        ),
    [columns, object, availableColumns],
  );
  const fields = useMemo(
    () => [...new Set([...visible.map((f) => f.name), ...extraFields])],
    [visible, extraFields],
  );

  const query = useInfiniteQuery({
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
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  // Selection and the keyboard cursor reset when the result set changes shape.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const resetKey = JSON.stringify([filter ?? null, sort]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the query changes.
  useEffect(() => {
    setSelected(new Set());
    setActive(-1);
  }, [resetKey]);

  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (active < 0) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);

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
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const someSelected = !allSelected && rows.some((row) => selected.has(row.id));
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const selectable = Boolean(bulkActions);
  const colSpan = visible.length + (selectable ? 1 : 0);

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

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      {selectable && selectedRows.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="toolbar"
          aria-label="Bulk actions"
          data-testid="bulk-actions"
        >
          <span className="font-medium">{selectedRows.length} selected</span>
          <div className="flex-1" />
          {bulkActions?.({ selected: selectedRows, clear: () => setSelected(new Set()) })}
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <div className="rounded-md border">
        <Table aria-label={label} aria-busy={query.isFetching} data-testid="data-table">
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all"
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(checked) =>
                      setSelected(checked ? new Set(rows.map((row) => row.id)) : new Set())
                    }
                  />
                </TableHead>
              )}
              {visible.map((field) => {
                const sorted = sort.field === field.name ? sort.direction : null;
                return (
                  <TableHead
                    key={field.name}
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                  >
                    {field.sortable ? (
                      <button
                        type="button"
                        className="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={() => onHeaderClick(field)}
                      >
                        {field.label}
                        {sorted === "asc" ? (
                          <ArrowUpIcon className="size-3.5" aria-hidden />
                        ) : sorted === "desc" ? (
                          <ArrowDownIcon className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowUpDownIcon className="size-3.5 opacity-40" aria-hidden />
                        )}
                        <span className="sr-only">
                          {sorted ? `, sorted ${sorted}ending` : ", sortable"}
                        </span>
                      </button>
                    ) : (
                      field.label
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody ref={bodyRef}>
            {query.isPending &&
              Array.from({ length: 5 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows.
                <TableRow key={i} data-testid="row-skeleton">
                  {Array.from({ length: colSpan }, (_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton cells.
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full max-w-40" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {query.isError && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-8 text-center">
                  <p className="text-sm text-destructive" role="alert">
                    {errorMessage(query.error)}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => query.refetch()}
                  >
                    Try again
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {query.isSuccess && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colSpan} className="p-4">
                  {filter ? (
                    <EmptyState
                      icon={SearchXIcon}
                      title="No matches"
                      description="Nothing matches this filter. Change or clear it."
                    />
                  ) : (
                    (empty ?? <EmptyState title={`No ${label.toLowerCase()} yet`} />)
                  )}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row, index) => (
              <TableRow
                key={row.id}
                data-index={index}
                data-active={index === active || undefined}
                data-state={selected.has(row.id) ? "selected" : undefined}
                aria-selected={selectable ? selected.has(row.id) : undefined}
                className="data-[active]:bg-accent data-[active]:outline-2 data-[active]:-outline-offset-2 data-[active]:outline-ring/50"
                onClick={() => setActive(index)}
                onDoubleClick={() => onOpen?.(row)}
              >
                {selectable && (
                  <TableCell>
                    <Checkbox
                      aria-label="Select row"
                      checked={selected.has(row.id)}
                      onCheckedChange={() => toggle(row.id)}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </TableCell>
                )}
                {visible.map((field) => (
                  <TableCell key={field.name} className="max-w-72 truncate">
                    {renderCell[field.name]?.(row) ?? (
                      <DefaultCell
                        field={field}
                        value={(row as Record<string, unknown>)[field.name]}
                      />
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span aria-live="polite">
          {query.isSuccess &&
            `${rows.length}${query.hasNextPage ? "+" : ""} ${rows.length === 1 ? "row" : "rows"}`}
        </span>
        {query.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}
