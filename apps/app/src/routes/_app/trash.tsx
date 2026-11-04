// Trash: soft-deleted people, organisations, activities and tasks (trash.list), newest first, in
// a virtualised list that loads more as you scroll. Each is restorable with its object's restore
// operation until its restorable-until date; restoring is optimistic and offers Undo.
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Building2Icon,
  CheckSquareIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { VirtualFeed } from "#/components/layout/infinite";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { formatDate, formatDateTime } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { updateCached } from "#/lib/optimistic";
import { errorMessage, invalidateAfterWrite, opKey } from "#/lib/query";
import { useUserLabel } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/trash")({ component: TrashPage });

type TrashObject = "person" | "organisation" | "activity" | "task";

const OBJECTS: Record<TrashObject, { label: string; icon: LucideIcon }> = {
  person: { label: "Person", icon: UserIcon },
  organisation: { label: "Organisation", icon: Building2Icon },
  activity: { label: "Activity", icon: MessageSquareTextIcon },
  task: { label: "Task", icon: CheckSquareIcon },
};

const ALL = "all";

/** Moves a restored item back to Trash (Undo). */
function trashAgain(object: TrashObject, id: string) {
  switch (object) {
    case "person":
      return callOp("person.delete", { id });
    case "organisation":
      return callOp("organisation.delete", { id });
    case "activity":
      return callOp("activity.delete", { id });
    case "task":
      return callOp("task.delete", { id });
  }
}

/** Restores one item with its object's restore operation. */
function restore(object: TrashObject, id: string) {
  switch (object) {
    case "person":
      return callOp("person.restore", { id });
    case "organisation":
      return callOp("organisation.restore", { id });
    case "activity":
      return callOp("activity.restore", { id });
    case "task":
      return callOp("task.restore", { id });
  }
}

function TrashPage() {
  const client = useQueryClient();
  const userLabel = useUserLabel();
  const [object, setObject] = useState<TrashObject | typeof ALL>(ALL);
  const [restoring, setRestoring] = useState<string | null>(null);
  const input = { ...(object === ALL ? {} : { object }), limit: 50 };
  const trash = useInfiniteQuery({
    queryKey: opKey("trash.list", input),
    queryFn: ({ pageParam }) =>
      callOp("trash.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(() => trash.data?.pages.flatMap((p) => p.items) ?? [], [trash.data]);

  async function onRestore(item: (typeof items)[number]) {
    setRestoring(item.id);
    // Optimistic: the item leaves the list at once and comes back if the restore fails.
    const rollback = updateCached(client, ["trash.list"], (data) => {
      const paged = data as { pages: { items: { id: string }[] }[] } | undefined;
      if (!paged?.pages) return data;
      return {
        ...paged,
        pages: paged.pages.map((page) => ({
          ...page,
          items: page.items.filter((i) => i.id !== item.id),
        })),
      };
    });
    try {
      await restore(item.object, item.id);
      toast.success(`Restored ${item.name}`, {
        action: {
          label: "Undo",
          onClick: () =>
            void trashAgain(item.object, item.id)
              .then(() =>
                invalidateAfterWrite(client, `${item.object}.delete`, ["person.", "organisation."]),
              )
              .catch((error: unknown) => toast.error(errorMessage(error))),
        },
      });
    } catch (error) {
      rollback();
      toast.error(errorMessage(error));
    } finally {
      setRestoring(null);
      await invalidateAfterWrite(client, `${item.object}.restore`, ["person.", "organisation."]);
    }
  }

  return (
    <PageLayout
      title="Trash"
      width="lg"
      count={
        <PageCount
          value={trash.isSuccess ? items.length : undefined}
          capped={trash.hasNextPage}
          isPending={trash.isPending}
          noun="items in Trash"
        />
      }
      description="Deleted records stay restorable for 30 days, then the scheduled purge removes them."
      actions={
        <Select value={object} onValueChange={(v) => setObject(v as TrashObject | typeof ALL)}>
          <SelectTrigger size="sm" className="w-40" aria-label="Show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everything</SelectItem>
            <SelectItem value="person">People</SelectItem>
            <SelectItem value="organisation">Organisations</SelectItem>
            <SelectItem value="activity">Activities</SelectItem>
            <SelectItem value="task">Tasks</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      {trash.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : trash.isError && !items.length ? (
        <ErrorState
          title="Could not load Trash"
          error={trash.error}
          onRetry={() => void trash.refetch()}
        />
      ) : !items.length ? (
        <EmptyState icon={Trash2Icon} title="Trash is empty" />
      ) : (
        <VirtualFeed
          as="ul"
          label="Trash"
          items={items}
          getKey={(item) => `${item.object}:${item.id}`}
          estimateSize={64}
          source={trash}
          className="rounded-md border"
          itemClassName="border-b last:border-b-0"
          itemTestId="trash-item"
          renderItem={(item) => {
            const { icon: Icon, label } = OBJECTS[item.object];
            return (
              <div className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-center gap-2">
                    {item.object === "person" ? (
                      <Link
                        to="/people/$id"
                        params={{ id: item.id }}
                        className="truncate font-medium hover:underline"
                      >
                        {item.name}
                      </Link>
                    ) : (
                      <span className="truncate font-medium">{item.name}</span>
                    )}
                    <Badge variant="outline">{label}</Badge>
                    {item.mergedIntoId && <Badge variant="secondary">Merged</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Deleted {formatDateTime(item.deletedAt)}
                    {item.deletedBy ? ` by ${userLabel(item.deletedBy)}` : ""} · restorable until{" "}
                    <time dateTime={item.restorableUntil}>{formatDate(item.restorableUntil)}</time>
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onRestore(item)}
                  disabled={restoring === item.id}
                  aria-label={`Restore ${item.name}`}
                >
                  <RotateCcwIcon />
                  Restore
                </Button>
              </div>
            );
          }}
        />
      )}
    </PageLayout>
  );
}
