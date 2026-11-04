// A record's tasks: the side-panel card (open tasks) and the full list for the Tasks tab.
import { Button } from "@crm/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { CheckSquareIcon, PlusIcon } from "lucide-react";
import { formatDate } from "#/lib/format";
import { EmptyState } from "../empty-state.tsx";
import type { TaskItem } from "./adapters.ts";

export interface TaskListProps {
  tasks: TaskItem[];
  isPending?: boolean;
  /** False while task.list is not available. */
  wired?: boolean;
  /** Completes or reopens a task; null renders read-only checkboxes. */
  onToggle?: ((id: string, done: boolean) => void) | null;
  /** Hide done tasks (the card does; the tab shows all). */
  openOnly?: boolean;
}

function isOverdue(task: TaskItem): boolean {
  if (task.status === "done" || !task.dueAt) return false;
  return task.dueAt.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

export function TaskList({ tasks, isPending, wired = true, onToggle, openOnly }: TaskListProps) {
  if (isPending) return <Skeleton className="h-16" />;
  const shown = openOnly ? tasks.filter((t) => t.status === "open") : tasks;
  if (!shown.length) {
    return (
      <EmptyState
        icon={CheckSquareIcon}
        title={wired ? "No open tasks" : "Tasks coming soon"}
        description={wired ? undefined : "Follow-ups linked to this record will show up here."}
        className="py-6"
      />
    );
  }
  return (
    <ul className="grid gap-2" aria-label="Tasks">
      {shown.map((task) => (
        <li key={task.id} className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={task.status === "done"}
            disabled={!onToggle}
            onCheckedChange={(checked) => onToggle?.(task.id, checked === true)}
            aria-label={`Done: ${task.title}`}
            className="mt-0.5"
          />
          <div className="grid min-w-0 flex-1">
            <span
              className={cn(
                "truncate",
                task.status === "done" && "text-muted-foreground line-through",
              )}
            >
              {task.title}
            </span>
            {task.dueAt && (
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  isOverdue(task) && "text-destructive",
                )}
              >
                Due {formatDate(task.dueAt)}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface TasksCardProps extends TaskListProps {
  /** Opens task quick-add; null disables the button (task.create not available yet). */
  onAdd?: (() => void) | null;
}

export function TasksCard({ onAdd, ...list }: TasksCardProps) {
  return (
    <Card className="gap-3 py-4" data-testid="tasks-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Tasks</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add task"
            disabled={!onAdd}
            onClick={() => onAdd?.()}
          >
            <PlusIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        <TaskList {...list} openOnly />
      </CardContent>
    </Card>
  );
}
