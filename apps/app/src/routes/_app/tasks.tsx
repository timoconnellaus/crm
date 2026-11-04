// Tasks: "My tasks" (task.listMine, grouped by due date in the browser's timezone) and an
// all-tasks table (task.list) with status/assignee quick filters and the filter builder.
// Quick-add with `c`, the New task button or the command palette.
import { type Filter, type Sort, taskObject } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Kbd } from "@crm/ui/components/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { cn } from "@crm/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckSquareIcon, ListPlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAppCommands } from "#/components/app-commands";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState } from "#/components/empty-state";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { toTaskItem, useTaskActions } from "#/components/record/adapters";
import { formatDue, isOverdue, TaskList } from "#/components/record/tasks";
import { RecordLink } from "#/components/record/timeline";
import { callOp } from "#/lib/operations";
import { errorMessage, useOp } from "#/lib/query";
import { useUserLabel, useUsers } from "#/lib/users-adapter";

type TasksTab = "mine" | "all";

export const Route = createFileRoute("/_app/tasks")({
  validateSearch: (search: Record<string, unknown>): { tab?: TasksTab } =>
    search.tab === "all" ? { tab: "all" } : {},
  component: TasksPage,
});

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function TasksPage() {
  const { tab = "mine" } = Route.useSearch();
  const navigate = useNavigate({ from: "/tasks" });
  const { create } = useAppCommands();
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <div className="flex-1" />
        <Button onClick={() => create("task")} aria-keyshortcuts="c">
          <ListPlusIcon />
          New task
          <Kbd className="ml-1 hidden bg-primary-foreground/20 text-primary-foreground sm:inline-flex">
            C
          </Kbd>
        </Button>
      </div>
      <Tabs
        value={tab}
        onValueChange={(next) =>
          navigate({ search: next === "all" ? { tab: "all" } : {}, replace: true })
        }
        className="gap-4"
      >
        <TabsList>
          <TabsTrigger value="mine">My tasks</TabsTrigger>
          <TabsTrigger value="all">All tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="mine" className="mt-0">
          <MyTasks />
        </TabsContent>
        <TabsContent value="all" className="mt-0">
          <AllTasks />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const BUCKETS = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "thisWeek", label: "This week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No due date" },
] as const;

function MyTasks() {
  const timezone = useMemo(browserTimeZone, []);
  const mine = useOp("task.listMine", { timezone });
  const actions = useTaskActions(null, null);
  const { create } = useAppCommands();

  if (mine.isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (mine.isError) {
    return <EmptyState title="Could not load your tasks" description={errorMessage(mine.error)} />;
  }
  const total = BUCKETS.reduce((n, b) => n + mine.data.counts[b.key], 0);
  if (!total) {
    return (
      <EmptyState
        icon={CheckSquareIcon}
        title="Nothing to do"
        description="Open tasks assigned to you show up here, grouped by due date."
        action={
          <Button onClick={() => create("task")}>
            <ListPlusIcon />
            New task
          </Button>
        }
      />
    );
  }
  return (
    <div className="grid gap-6" data-testid="my-tasks">
      {BUCKETS.filter((b) => mine.data.counts[b.key] > 0).map((bucket) => (
        <section key={bucket.key} className="grid gap-2" aria-labelledby={`bucket-${bucket.key}`}>
          <h2
            id={`bucket-${bucket.key}`}
            className={cn(
              "flex items-center gap-2 text-sm font-medium",
              bucket.key === "overdue" && "text-destructive",
            )}
          >
            {bucket.label}
            <Badge variant="secondary">{mine.data.counts[bucket.key]}</Badge>
          </h2>
          <div className="rounded-md border p-3">
            <TaskList
              label={bucket.label}
              tasks={mine.data.buckets[bucket.key].map(toTaskItem)}
              onToggle={actions.setDone}
              showLinks
            />
          </div>
        </section>
      ))}
      {mine.data.truncated && (
        <p className="text-sm text-muted-foreground">
          Showing your first 500 open tasks. Use All tasks to see the rest.
        </p>
      )}
    </div>
  );
}

type TaskRow = ReturnType<typeof toTaskItem> & { completedAt?: string | null; createdAt?: string };

const TASK_COLUMNS = ["title", "dueAt", "status", "assigneeId", "createdAt", "completedAt"];
const DEFAULT_SORT: Sort = { field: "dueAt", direction: "asc" };
const ANY = "__any__";

function AllTasks() {
  const { user } = Route.useRouteContext();
  const users = useUsers();
  const userLabel = useUserLabel();
  const actions = useTaskActions(null, null);
  const [status, setStatus] = useState<string>("open");
  const [assignee, setAssignee] = useState<string>(ANY);
  const [filter, setFilter] = useState<Filter | undefined>(undefined);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  const combined = useMemo<Filter | undefined>(() => {
    const parts: Filter[] = [];
    if (status !== ANY) parts.push({ field: "status", op: "eq", value: status });
    if (assignee !== ANY) {
      parts.push(
        assignee === "none"
          ? { field: "assigneeId", op: "is_null" }
          : { field: "assigneeId", op: "eq", value: assignee },
      );
    }
    if (filter) parts.push(filter);
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : { and: parts };
  }, [status, assignee, filter]);

  const fetchPage = useCallback(async (input: ListPageRequest): Promise<ListPage<TaskRow>> => {
    const page = await callOp("task.list", input);
    return {
      items: page.items.map((t) => ({ ...t, ...toTaskItem(t) })),
      nextCursor: page.nextCursor,
    };
  }, []);

  async function toggle(id: string, done: boolean) {
    try {
      await actions.setDone(id, done);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-32" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value={ANY}>Any status</SelectItem>
          </SelectContent>
        </Select>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger size="sm" className="w-44" aria-label="Assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Anyone</SelectItem>
            <SelectItem value={user.id}>Me</SelectItem>
            <SelectItem value="none">Unassigned</SelectItem>
            {users
              .filter((u) => u.id !== user.id)
              .map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <FilterBuilder
          object={taskObject}
          value={filter}
          onChange={setFilter}
          fields={["title", "notes", "dueAt", "completedAt", "createdAt", "linkedRecordId"]}
        />
      </div>
      <DataTable<TaskRow>
        object={taskObject}
        label="All tasks"
        queryKey={["op", "task.list", "table"]}
        fetchPage={fetchPage}
        columns={TASK_COLUMNS}
        availableColumns={TASK_COLUMNS}
        extraFields={["links", "assigneeName"]}
        sort={sort}
        onSortChange={setSort}
        {...(combined ? { filter: combined } : {})}
        renderCell={{
          title: (row) => (
            <span className="flex items-start gap-2">
              <Checkbox
                checked={row.status === "done"}
                onCheckedChange={(checked) => void toggle(row.id, checked === true)}
                aria-label={`Done: ${row.title}`}
                className="mt-0.5"
              />
              <span className="grid min-w-0">
                <span
                  className={cn(
                    "font-medium",
                    row.status === "done" && "text-muted-foreground line-through",
                  )}
                >
                  {row.title}
                </span>
                {row.links.length > 0 && (
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    {row.links
                      .filter((l) => l.object === "person" || l.object === "organisation")
                      .map((l) => (
                        <RecordLink key={l.id} object={l.object} id={l.id}>
                          {l.title ?? l.id}
                        </RecordLink>
                      ))}
                  </span>
                )}
              </span>
            </span>
          ),
          dueAt: (row) =>
            row.dueAt ? (
              <span className={cn(isOverdue(row) && "text-destructive")}>
                {formatDue(row.dueAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
          assigneeId: (row) =>
            row.assigneeId ? (
              (row.assigneeName ?? userLabel(row.assigneeId))
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            ),
        }}
        empty={<EmptyState icon={CheckSquareIcon} title="No tasks yet" />}
        keyboard={false}
      />
    </div>
  );
}
