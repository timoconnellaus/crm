// History tab: field-level diffs from the audit log, newest first.
import { getField, type ObjectDefinition } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Skeleton } from "@crm/ui/components/skeleton";
import { HistoryIcon } from "lucide-react";
import { formatDateTime, formatValue } from "#/lib/format";
import { EmptyState } from "../empty-state.tsx";
import type { HistoryEntry } from "./adapters.ts";

export interface HistoryListProps {
  /** For field labels. */
  object: ObjectDefinition;
  entries: HistoryEntry[];
  isPending?: boolean;
  /** False while the audit read operation is not available. */
  wired?: boolean;
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
};

/** One value of a diff as display text (lists of emails/phones show their main value). */
export function diffValue(value: unknown): string {
  if (Array.isArray(value)) {
    return (
      value
        .map((item) =>
          item && typeof item === "object"
            ? String(
                (item as Record<string, unknown>).email ??
                  (item as Record<string, unknown>).number ??
                  (item as Record<string, unknown>).url ??
                  JSON.stringify(item),
              )
            : formatValue(item),
        )
        .join(", ") || "empty"
    );
  }
  return formatValue(value) || "empty";
}

export function HistoryList({ object, entries, isPending, wired = true }: HistoryListProps) {
  if (isPending) return <Skeleton className="h-24" />;
  if (!entries.length) {
    return (
      <EmptyState
        icon={HistoryIcon}
        title={wired ? "No changes yet" : "History coming soon"}
        description={
          wired
            ? undefined
            : "Every change to this record, who made it and what it was, will show up here."
        }
      />
    );
  }
  return (
    <ol className="grid gap-4" aria-label="Change history">
      {entries.map((entry) => {
        const who = [entry.userName, ACTOR_LABEL[entry.actor]].filter(Boolean).join(" via ");
        return (
          <li key={entry.id} className="grid gap-1 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <Badge variant="outline">{ACTION_LABEL[entry.action]}</Badge>
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
  );
}
