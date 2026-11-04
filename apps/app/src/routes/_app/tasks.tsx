// Tasks: "My tasks" (task.listMine, grouped by due date in the browser's timezone) and an
// all-tasks table (task.list, virtualised with infinite scroll) with status/assignee quick
// filters and the filter builder. The header (title, live count, tabs, filters) stays fixed.
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
import { Tabs, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { cn } from "@crm/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckSquareIcon, ListPlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAppCommands } from "#/components/app-commands";
import { DataTable, type ListPage, type ListPageRequest } from "#/components/data-table/data-table";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { FilterBuilder } from "#/components/filter-builder/filter-builder";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { toTaskItem, useTaskActions } from "#/components/record/adapters";
import { formatDue, isOverdue, TaskList } from "#/components/record/tasks";
import { RecordLink } from "#/components/record/timeline";
import { countQueryOptions } from "#/lib/count";
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
  const all = useAllTasksFilters();
  const timezone = useMemo(browserTimeZone, []);
  const mine = useOp("task.listMine", { timezone });
  const allCount = useQuery({ ...countQueryOptions("task", all.combined), enabled: tab === "all" });
  const mineCount = mine.data
    ? BUCKETS.reduce((n, b) => n + (mine.data?.counts[b.key] ?? 0), 0)
    : undefined;

  return (
    <PageLayout
      title="Tasks"
      width={tab === "all" ? "fluid" : "xl"}
      scroll={tab === "all" ? "none" : "body"}
      count={
        tab === "all" ? (
          <PageCount
            value={allCount.data?.count}
            capped={allCount.data?.capped}
            isPending={allCount.isPending}
            noun="tasks"
          />
        ) : (
          <PageCount value={mineCount} isPending={mine.isPending} noun="open tasks" />
        )
      }
      actions={
        <Button onClick={() => create("task")} aria-keyshortcuts="c">
          <ListPlusIcon />
          <span className="max-sm:sr-only">New task</span>
          <Kbd className="ml-1 hidden bg-primary-foreground/20 text-primary-foreground sm:inline-flex">
            C
          </Kbd>
        </Button>
      }
      tabs={
        <Tabs
          value={tab}
          onValueChange={(next) =>
            navigate({ search: next === "all" ? { tab: "all" } : {}, replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="mine">My tasks</TabsTrigger>
            <TabsTrigger value="all">All tasks</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      toolbar={tab === "all" ? <AllTasksFilters state={all} /> : undefined}
    >
      {tab === "all" ? <AllTasks state={all} total={allCount.data} /> : <MyTasks />}
    </PageLayout>
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
    return (
      <ErrorState
        title="Could not load your tasks"
        error={mine.error}
        onRetry={() => void mine.refetch()}
      />
    );
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

/** The all-tasks quick filters (status, assignee) and filter builder, kept by the page. */
function useAllTasksFilters() {
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

  return {
    status,
    setStatus,
    assignee,
    setAssignee,
    filter,
    setFilter,
    sort,
    setSort,
    combined,
  };
}

type AllTasksState = ReturnType<typeof useAllTasksFilters>;

function AllTasksFilters({ state }: { state: AllTasksState }) {
  const { user } = Route.useRouteContext();
  const users = useUsers();
  return (
    <>
      <Select value={state.status} onValueChange={state.setStatus}>
        <SelectTrigger size="sm" className="w-32" aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open">Open</SelectItem>
          <SelectItem value="done">Done</SelectItem>
          <SelectItem value={ANY}>Any status</SelectItem>
        </SelectContent>
      </Select>
      <Select value={state.assignee} onValueChange={state.setAssignee}>
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
        value={state.filter}
        onChange={state.setFilter}
        fields={["title", "notes", "dueAt", "completedAt", "createdAt", "linkedRecordId"]}
      />
    </>
  );
}

function AllTasks({
  state,
  total,
}: {
  state: AllTasksState;
  total: { count: number; capped: boolean } | undefined;
}) {
  const userLabel = useUserLabel();
  const actions = useTaskActions(null, null);
  const { combined, sort, setSort } = state;

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
      total={total}
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
            <span className={cn(isOverdue(row) && "text-destructive")}>{formatDue(row.dueAt)}</span>
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
    />
  );
}
