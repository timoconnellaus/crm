// Activity: the recent activity feed across all records (activity.list, newest first), with a
// type filter and "only mine" in the fixed header, a live count, and a virtualised feed that
// loads more as you scroll. Each item links to the records it is on. A `filter` search param
// (a dashboard click-through) narrows the feed further until it is cleared.
import { type Filter, filterSchema } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MessageSquareTextIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { VirtualFeed } from "#/components/layout/infinite";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { type ActivityType, toTimelineItem } from "#/components/record/adapters";
import { TimelineEntry, TimelineFilter, TimelineSkeleton } from "#/components/record/timeline";
import { useRecordCount } from "#/lib/count";
import { callOp } from "#/lib/operations";
import { opKey } from "#/lib/query";

function parseFilter(raw: unknown): Filter | undefined {
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

export const Route = createFileRoute("/_app/activity")({
  validateSearch: (search: Record<string, unknown>): { filter?: Filter } => {
    const filter = parseFilter(search.filter);
    return filter ? { filter } : {};
  },
  component: ActivityPage,
});

function ActivityPage() {
  const { user } = Route.useRouteContext();
  const { filter: linked } = Route.useSearch();
  const navigate = useNavigate({ from: "/activity" });
  const [types, setTypes] = useState<ActivityType[]>([]);
  const [mineOnly, setMineOnly] = useState(false);

  const filter = useMemo<Filter | undefined>(() => {
    const parts: Filter[] = linked ? [linked] : [];
    if (types.length) parts.push({ field: "type", op: "in", value: types });
    if (mineOnly) parts.push({ field: "authorUserId", op: "eq", value: user.id });
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : { and: parts };
  }, [types, mineOnly, user.id, linked]);

  const input = {
    ...(filter ? { filter } : {}),
    sort: { field: "occurredAt", direction: "desc" as const },
    limit: 30,
  };
  const feed = useInfiniteQuery({
    queryKey: opKey("activity.list", input),
    queryFn: ({ pageParam }) =>
      callOp("activity.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(
    () => feed.data?.pages.flatMap((p) => p.items.map(toTimelineItem)) ?? [],
    [feed.data],
  );
  const count = useRecordCount("activity", filter);

  return (
    <PageLayout
      title="Activity"
      width="md"
      count={
        <PageCount
          value={count.data?.count}
          capped={count.data?.capped}
          isPending={count.isPending}
          noun="activities"
        />
      }
      toolbar={
        <>
          <TimelineFilter value={types} onChange={setTypes} />
          {linked && (
            <Button
              size="xs"
              variant="secondary"
              data-testid="linked-filter"
              onClick={() => navigate({ search: {}, replace: true })}
            >
              Filtered list
              <XIcon />
            </Button>
          )}
          <div className="flex-1" />
          <Button
            size="xs"
            variant={mineOnly ? "secondary" : "ghost"}
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((v) => !v)}
          >
            Only mine
          </Button>
        </>
      }
    >
      {feed.isPending ? (
        <TimelineSkeleton rows={6} />
      ) : feed.isError && !items.length ? (
        <ErrorState
          title="Could not load activity"
          error={feed.error}
          onRetry={() => void feed.refetch()}
        />
      ) : !items.length ? (
        <EmptyState
          icon={MessageSquareTextIcon}
          title={filter ? "No matching activity" : "No activity yet"}
          description="Notes, emails, calls, meetings and changes show up here."
        />
      ) : (
        <VirtualFeed
          label="Timeline"
          items={items}
          getKey={(item) => item.id}
          estimateSize={84}
          source={feed}
          itemTestId="activity-item"
          renderItem={(item) => (
            <div className="ml-3 border-l pb-4 pl-6" data-activity-type={item.type}>
              <div className="relative">
                <TimelineEntry item={item} showLinks />
              </div>
            </div>
          )}
        />
      )}
    </PageLayout>
  );
}
