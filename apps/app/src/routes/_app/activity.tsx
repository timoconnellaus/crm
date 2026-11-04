// Activity: the recent activity feed across all records (activity.list, newest first), with a
// type filter and "only mine". Each item links to the records it is on.
import type { Filter } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { type ActivityType, toTimelineItem } from "#/components/record/adapters";
import { Timeline, TimelineFilter } from "#/components/record/timeline";
import { callOp } from "#/lib/operations";
import { opKey } from "#/lib/query";

export const Route = createFileRoute("/_app/activity")({ component: ActivityPage });

function ActivityPage() {
  const { user } = Route.useRouteContext();
  const [types, setTypes] = useState<ActivityType[]>([]);
  const [mineOnly, setMineOnly] = useState(false);

  const filter = useMemo<Filter | undefined>(() => {
    const parts: Filter[] = [];
    if (types.length) parts.push({ field: "type", op: "in", value: types });
    if (mineOnly) parts.push({ field: "authorUserId", op: "eq", value: user.id });
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : { and: parts };
  }, [types, mineOnly, user.id]);

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

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <div className="flex flex-wrap items-center gap-2">
        <TimelineFilter value={types} onChange={setTypes} />
        <div className="flex-1" />
        <Button
          size="xs"
          variant={mineOnly ? "secondary" : "ghost"}
          aria-pressed={mineOnly}
          onClick={() => setMineOnly((v) => !v)}
        >
          Only mine
        </Button>
      </div>
      <Timeline
        items={items}
        isPending={feed.isPending}
        error={feed.error}
        showLinks
        hasMore={feed.hasNextPage}
        onLoadMore={() => void feed.fetchNextPage()}
        isLoadingMore={feed.isFetchingNextPage}
        emptyTitle={filter ? "No matching activity" : "No activity yet"}
      />
    </div>
  );
}
