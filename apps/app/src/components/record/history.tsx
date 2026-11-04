// History tab: field-level diffs from the audit log, newest first.
import { getField, type ObjectDefinition } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Skeleton } from "@crm/ui/components/skeleton";
import { HistoryIcon } from "lucide-react";
import { diffValue, formatDateTime } from "#/lib/format";
import { EmptyState, ErrorState } from "../empty-state.tsx";
import { LoadMoreSentinel } from "../layout/infinite.tsx";
import type { HistoryEntry } from "./adapters.ts";

export interface HistoryListProps {
  /** For field labels. */
  object: ObjectDefinition;
  entries: HistoryEntry[];
  isPending?: boolean;
  error?: Error | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  loadMoreFailed?: boolean;
}

const ACTION_LABEL: Record<HistoryEntry["action"], string> = {
  create: "Created",
  update: "Updated",
  delete: "Moved to Trash",
  restore: "Restored",
  erase: "Erased",
  merge: "Merged",
};

const ACTOR_LABEL: Record<HistoryEntry["actor"], string> = {
  human: "",
  assistant: "AI assistant",
  mcp: "MCP client",
  automation: "Automation",
  extension: "Extension",
};

export { diffValue };

export function HistoryList({
  object,
  entries,
  isPending,
  error,
  hasMore,
  onLoadMore,
  isLoadingMore,
  loadMoreFailed,
}: HistoryListProps) {
  if (isPending) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (error) return <ErrorState title="Could not load history" error={error} />;
  if (!entries.length) return <EmptyState icon={HistoryIcon} title="No changes yet" />;
  return (
    <div className="grid gap-3">
      <ol className="grid gap-4" aria-label="Change history">
        {entries.map((entry) => {
          const who = [entry.userName, ACTOR_LABEL[entry.actor] ?? entry.actor]
            .filter(Boolean)
            .join(" via ");
          return (
            <li key={entry.id} className="grid gap-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <Badge variant="outline">{ACTION_LABEL[entry.action] ?? entry.action}</Badge>
                {who && <span className="font-medium">{who}</span>}
                <time dateTime={entry.at} className="text-xs text-muted-foreground">
                  {formatDateTime(entry.at)}
                </time>
              </div>
              {Object.keys(entry.diff).length > 0 && (
                <dl className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                  {Object.entries(entry.diff).map(([field, change]) => (
                    <div key={field} className="contents">
                      <dt className="text-muted-foreground">
                        {getField(object, field)?.label ?? field}
                      </dt>
                      <dd className="min-w-0 break-words">
                        <span className="text-muted-foreground line-through">
                          {diffValue(change.before)}
                        </span>{" "}
                        → {diffValue(change.after)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
      {hasMore && onLoadMore && (
        <LoadMoreSentinel
          label="more history"
          source={{
            hasNextPage: true,
            isFetching: Boolean(isLoadingMore),
            isFetchingNextPage: Boolean(isLoadingMore),
            isFetchNextPageError: Boolean(loadMoreFailed),
            fetchNextPage: onLoadMore,
          }}
        />
      )}
    </div>
  );
}
