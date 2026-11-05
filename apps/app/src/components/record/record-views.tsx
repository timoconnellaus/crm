// Record tabs and side panels that extensions declare (ADR 0058, `recordTabs` / `recordPanels`):
// each is a view spec of another object, filtered to records whose relation field points at the
// record being shown, rendered with our own table, board, calendar and gallery components.
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "#/components/empty-state";
import { LoadMoreSentinel } from "#/components/layout/infinite";
import type { RecordTab } from "#/components/record/record-layout";
import { BoardView } from "#/components/views/board-view";
import { CalendarView } from "#/components/views/calendar-view";
import { GalleryView } from "#/components/views/gallery-view";
import {
  andFilters,
  CardValue,
  fetchRecords,
  RecordTitleLink,
  viewKey,
} from "#/components/views/records";
import { useOp } from "#/lib/query";
import { type ObjectInfo, useObjectInfo } from "#/lib/schema";

type RecordViewsOutput = Awaited<
  ReturnType<typeof import("#/lib/operations").callOp<"view.recordViews">>
>;
type RecordView = RecordViewsOutput["tabs"][number];

/** Tab values of extension record tabs: `x:<extension>.<name>`. */
export const isRecordViewTab = (tab: unknown): tab is string =>
  typeof tab === "string" && /^x:[a-z][a-z0-9]*\.[a-zA-Z0-9]+$/.test(tab);

function RecordViewTable({
  info,
  view,
  filter,
}: {
  info: ObjectInfo;
  view: RecordView;
  filter: ReturnType<typeof andFilters>;
}) {
  const spec = view.spec;
  const columns = spec?.type === "table" ? spec.columns : [];
  const query = useInfiniteQuery({
    queryKey: viewKey(
      info.name,
      "record-table",
      filter ?? null,
      columns,
      spec && "sort" in spec ? spec.sort : null,
    ),
    queryFn: ({ pageParam }) =>
      fetchRecords(info.name, {
        filter,
        sort: spec && "sort" in spec && spec.sort ? spec.sort : undefined,
        limit: 50,
        fields: columns,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const fields = columns
    .map((c) => info.fields.find((f) => f.name === c))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (query.isPending) return <Skeleton className="h-32" />;
  if (!rows.length) {
    return (
      <EmptyState title={`No ${(info.plural ?? info.label).toLowerCase()} yet`} className="py-8" />
    );
  }
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" aria-label={view.label} data-testid="record-view-table">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              {fields.map((f) => (
                <th key={f.name} className="px-3 py-2 font-medium">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-0">
                {fields.map((f, i) => (
                  <td key={f.name} className="max-w-64 truncate px-3 py-2">
                    {i === 0 || f.name === info.titleField ? (
                      <RecordTitleLink object={info.name} record={row} />
                    ) : (
                      <CardValue field={f} value={row.values[f.name]} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMoreSentinel source={query} label={info.plural ?? info.label} />
    </div>
  );
}

function RecordViewBody({
  view,
  recordId,
  compact,
}: {
  view: RecordView;
  recordId: string;
  compact?: boolean;
}) {
  const object = view.spec?.object ?? "";
  const { object: info, isPending } = useObjectInfo(object);
  const [mode, setMode] = useState<"month" | "week" | "agenda">(
    view.spec?.type === "calendar" ? view.spec.mode : "month",
  );
  const filter = andFilters(
    { field: view.relation, op: "eq", value: recordId },
    view.spec?.filter ?? null,
  );
  if (view.error || !view.spec) {
    return (
      <p className="text-sm text-muted-foreground">
        {view.label} is unavailable: {view.error}
      </p>
    );
  }
  if (isPending) return <Skeleton className="h-32" />;
  if (!info) return null;
  const spec = view.spec;
  switch (spec.type) {
    case "table":
      return <RecordViewTable info={info} view={view} filter={filter} />;
    case "board":
      return (
        <div className={compact ? "h-80" : "h-[32rem]"}>
          <BoardView
            info={info}
            spec={{
              groupBy: spec.groupBy,
              sumField: spec.sumField ?? undefined,
              columnOrder: spec.columnOrder ?? undefined,
              cardFields: spec.cardFields,
              filter,
              sort: spec.sort ?? undefined,
            }}
          />
        </div>
      );
    case "calendar":
      return (
        <CalendarView
          info={info}
          spec={{ dateField: spec.dateField, mode, cardFields: spec.cardFields, filter }}
          onModeChange={setMode}
        />
      );
    case "gallery":
      return (
        <GalleryView
          info={info}
          spec={{
            imageField: spec.imageField ?? undefined,
            cardFields: spec.cardFields,
            filter,
            sort: spec.sort ?? undefined,
          }}
        />
      );
  }
}

/** The record page's extension tabs (as RecordTab entries) and side panels. */
export function useRecordViews(
  object: string,
  recordId: string,
): { tabs: RecordTab[]; panels: ReactNode } {
  const views = useOp("view.recordViews", { object }, { staleTime: 60_000 });
  return useMemo(() => {
    const tabs: RecordTab[] = (views.data?.tabs ?? [])
      .filter((v) => v.spec)
      .map((view) => ({
        value: `x:${view.id}`,
        label: view.label,
        content: <RecordViewBody view={view} recordId={recordId} />,
      }));
    const panels = (views.data?.panels ?? [])
      .filter((v) => v.spec)
      .map((view) => (
        <section
          key={view.id}
          className="grid gap-2 rounded-lg border p-4"
          data-testid={`record-panel-${view.id}`}
        >
          <h2 className="text-sm font-medium">{view.label}</h2>
          <RecordViewBody view={view} recordId={recordId} compact />
        </section>
      ));
    return { tabs, panels: panels.length ? panels : null };
  }, [views.data, recordId]);
}
