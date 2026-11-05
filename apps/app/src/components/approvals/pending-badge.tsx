// "Pending changes" badges (ADR 0022): on a record's header and on list rows, for records an agent
// has queued changes to. The UI reads real data, so this is how people learn a change is waiting.
// The popover lists each pending action with a link to its change set in the Approvals inbox.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@relationship-os/ui/components/popover";
import { cn } from "@relationship-os/ui/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClockIcon } from "lucide-react";
import { useMemo } from "react";
import { formatRelative } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { opKey, useOp } from "#/lib/query";
import { noun, verbOf } from "./describe.ts";

export type PendingItem = CoreOutput<"approval.pendingForRecord">["items"][number];

const ACTION_TEXT: Record<string, string> = {
  update: "change",
  delete: "move to Trash",
  erase: "erase",
  restore: "restore",
  merge: "merge",
  reference: "link to",
  create: "create",
};

function describeItem(item: PendingItem): string {
  const [object = ""] = item.operation.split(".");
  return `${verbOf(item.operation)} ${noun(object)}`;
}

const STYLE =
  "border-transparent bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25";

/** A badge with a popover of the pending actions on one record. */
export function PendingPopover({
  items,
  compact = false,
}: {
  items: readonly PendingItem[];
  /** List rows: a small "Pending" badge. */
  compact?: boolean;
}) {
  if (!items.length) return null;
  const label = `${items.length} pending change${items.length === 1 ? "" : "s"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={compact ? `${label}, waiting for approval` : undefined}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          data-testid="pending-badge"
        >
          <Badge variant="secondary" className={cn(STYLE, compact && "px-1.5 py-0 text-[11px]")}>
            <ClockIcon aria-hidden />
            {compact ? "Pending" : label}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="grid w-80 gap-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="grid gap-0.5">
          <p className="text-sm font-medium">Waiting for approval</p>
          <p className="text-xs text-muted-foreground">
            Not applied yet: people see the current data until someone approves.
          </p>
        </div>
        <ul className="grid gap-2.5" aria-label="Pending changes">
          {items.map((item) => (
            <li key={item.actionId} className="grid gap-0.5 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{describeItem(item)}</span>
                <Link
                  to="/approvals"
                  search={{ set: item.changeSetId }}
                  className="shrink-0 text-xs underline underline-offset-2"
                >
                  Review
                </Link>
              </div>
              <span className="text-xs text-muted-foreground">
                Would {ACTION_TEXT[item.action] ?? item.action} this record ·{" "}
                {item.clientName ?? "an agent"} · {formatRelative(item.createdAt)}
              </span>
              <span className="line-clamp-2 text-xs">Agent's reason: {item.reason}</span>
            </li>
          ))}
        </ul>
        <Button asChild variant="outline" size="sm">
          <Link to="/approvals">Open Approvals</Link>
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** The header badge on a record page. */
export function PendingChangesBadge({ object, id }: { object: string; id: string }) {
  const pending = useOp(
    "approval.pendingForRecord",
    { object, ids: [id] },
    { refetchOnWindowFocus: true },
  );
  return <PendingPopover items={pending.data?.items ?? []} />;
}

/**
 * Pending actions for the rows of a list, one `approval.pendingForRecord` call per page of ids
 * (at most 100 each), grouped by record id.
 */
export function usePendingForRows(
  object: string | undefined,
  pages: readonly (readonly { id: string }[])[],
): Map<string, PendingItem[]> {
  const batches = useMemo(
    () =>
      object
        ? pages
            .flatMap((rows) => {
              const ids = rows.map((r) => r.id);
              const out: string[][] = [];
              for (let i = 0; i < ids.length; i += 100) out.push(ids.slice(i, i + 100));
              return out;
            })
            .filter((ids) => ids.length > 0)
        : [],
    [object, pages],
  );
  return useQueries({
    queries: batches.map((ids) => ({
      queryKey: opKey("approval.pendingForRecord", { object: object ?? "", ids }),
      queryFn: () => callOp("approval.pendingForRecord", { object: object ?? "", ids }),
      staleTime: 15_000,
      refetchOnWindowFocus: true,
    })),
    combine: byRecord,
  });
}

/** Stable, so TanStack Query only recombines when a result changes. */
function byRecord(
  results: readonly { data?: { items: PendingItem[] } | undefined }[],
): Map<string, PendingItem[]> {
  const map = new Map<string, PendingItem[]>();
  for (const result of results) {
    for (const item of result.data?.items ?? []) {
      map.set(item.recordId, [...(map.get(item.recordId) ?? []), item]);
    }
  }
  return map;
}
