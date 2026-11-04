// Trash: soft-deleted people, organisations, activities and tasks (trash.list), newest first,
// each restorable with its object's restore operation until its restorable-until date.
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
import { EmptyState } from "#/components/empty-state";
import { formatDate, formatDateTime } from "#/lib/format";
import { callOp } from "#/lib/operations";
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
    try {
      await restore(item.object, item.id);
      await invalidateAfterWrite(client, `${item.object}.restore`, ["person.", "organisation."]);
      toast.success(`Restored ${item.name}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
        <div className="flex-1" />
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
      </div>
      <p className="text-sm text-muted-foreground">
        Deleted records stay restorable for 30 days, then the scheduled purge removes them.
      </p>
      {trash.isPending ? (
        <div className="grid gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : trash.isError ? (
        <EmptyState title="Could not load Trash" description={errorMessage(trash.error)} />
      ) : !items.length ? (
        <EmptyState icon={Trash2Icon} title="Trash is empty" />
      ) : (
        <ul className="grid divide-y rounded-md border" aria-label="Trash">
          {items.map((item) => {
            const { icon: Icon, label } = OBJECTS[item.object];
            return (
              <li
                key={`${item.object}:${item.id}`}
                className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm"
                data-testid="trash-item"
              >
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
              </li>
            );
          })}
        </ul>
      )}
      {trash.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-center"
          onClick={() => void trash.fetchNextPage()}
          disabled={trash.isFetchingNextPage}
        >
          {trash.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
