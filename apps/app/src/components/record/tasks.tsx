// A record's tasks: the side-panel card (open tasks) and the full list for the Tasks tab. The
// list is also used by the Tasks page.
import { Button } from "@relationship-os/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@relationship-os/ui/components/card";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { CheckSquareIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "#/lib/format";
import { errorMessage } from "#/lib/query";
import { EmptyState, ErrorState } from "../empty-state.tsx";
import type { TaskItem } from "./adapters.ts";
import { RecordLink } from "./timeline.tsx";

/** The local calendar date today, `YYYY-MM-DD`. */
export function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isOverdue(task: Pick<TaskItem, "status" | "dueAt">): boolean {
  if (task.status === "done" || !task.dueAt) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt)) return task.dueAt < localToday();
  return Date.parse(task.dueAt) < Date.now();
}

/** "Due 4 Nov 2026" for dates, with the time for due times. */
export function formatDue(dueAt: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dueAt)
    ? formatDate(`${dueAt}T00:00:00`)
    : formatDateTime(dueAt);
}

export interface TaskListProps {
  tasks: TaskItem[];
  isPending?: boolean;
  error?: Error | null;
  /** Completes or reopens a task; null renders read-only checkboxes. */
  onToggle?: ((id: string, done: boolean) => Promise<void>) | null;
  /** Hide done tasks (the card does; the tab shows all). */
  openOnly?: boolean;
  /** Show the records each task is about (the Tasks page). */
  showLinks?: boolean;
  /** Show the assignee (lists with other people's tasks). */
  showAssignee?: boolean;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  /** Accessible name of the list. */
  label?: string;
}

export function TaskList({
  tasks,
  isPending,
  error,
  onToggle,
  openOnly,
  showLinks,
  showAssignee,
  emptyTitle = "No open tasks",
  emptyDescription,
  label = "Tasks",
}: TaskListProps) {
  if (isPending) return <Skeleton className="h-16" />;
  if (error) {
    return <ErrorState title="Could not load tasks" error={error} className="py-6" />;
  }
  const shown = openOnly ? tasks.filter((t) => t.status === "open") : tasks;
  if (!shown.length) {
    return (
      <EmptyState
        icon={CheckSquareIcon}
        title={emptyTitle}
        description={emptyDescription}
        className="py-6"
      />
    );
  }

  async function toggle(id: string, done: boolean) {
    try {
      await onToggle?.(id, done);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  return (
    <ul className="grid gap-2" aria-label={label}>
      {shown.map((task) => (
        <li key={task.id} className="flex items-start gap-2 text-sm" data-task-status={task.status}>
          <Checkbox
            checked={task.status === "done"}
            disabled={!onToggle}
            onCheckedChange={(checked) => void toggle(task.id, checked === true)}
            aria-label={`Done: ${task.title}`}
            className="mt-0.5"
          />
          <div className="grid min-w-0 flex-1">
            <span
              className={cn(
                "break-words",
                task.status === "done" && "text-muted-foreground line-through",
              )}
            >
              {task.title}
            </span>
            <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {task.dueAt && (
                <span className={cn(isOverdue(task) && "text-destructive")}>
                  Due {formatDue(task.dueAt)}
                </span>
              )}
              {showAssignee && task.assigneeName && <span>{task.assigneeName}</span>}
              {showLinks &&
                task.links
                  .filter((l) => l.object === "person" || l.object === "organisation")
                  .map((link) => (
                    <RecordLink key={`${link.object}:${link.id}`} object={link.object} id={link.id}>
                      {link.title ?? link.id}
                    </RecordLink>
                  ))}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface TasksCardProps extends TaskListProps {
  /** Opens task quick-add; null hides the button (read-only record). */
  onAdd?: (() => void) | null;
}

export function TasksCard({ onAdd, ...list }: TasksCardProps) {
  return (
    <Card className="gap-3 py-4" data-testid="tasks-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Tasks</CardTitle>
        {onAdd && (
          <CardAction>
            <Button variant="ghost" size="icon-sm" aria-label="Add task" onClick={() => onAdd()}>
              <PlusIcon />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-4">
        <TaskList {...list} openOnly />
      </CardContent>
    </Card>
  );
}
