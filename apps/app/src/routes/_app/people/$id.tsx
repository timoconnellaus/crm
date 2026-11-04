// Person record page, layout B: header with actions, tabs (Overview, Timeline, Tasks, History),
// composer + timeline in the main column, and details, organisations and tasks in the side
// panel. Deleted people stay viewable here with a Restore banner.
import { personObject } from "@crm/core/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@crm/ui/components/alert-dialog";
import { Button } from "@crm/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@crm/ui/components/dropdown-menu";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@crm/ui/components/tooltip";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  EllipsisIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  UserXIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "#/components/empty-state";
import { useMergeAction } from "#/components/merge/merge-action";
import { PersonDetailsCard } from "#/components/people/person-details-card";
import {
  type RecordRef,
  useCreateActivity,
  usePersonAffiliations,
  useRecordHistory,
  useRecordTasks,
  useTaskActions,
  useTimeline,
} from "#/components/record/adapters";
import { AffiliationsCard } from "#/components/record/affiliations-card";
import { HistoryList } from "#/components/record/history";
import { RecordLayout } from "#/components/record/record-layout";
import { TaskList, TasksCard } from "#/components/record/tasks";
import { ActivityComposer, Timeline } from "#/components/record/timeline";
import { formatDate } from "#/lib/format";
import { OperationCallError } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const TABS = ["overview", "timeline", "tasks", "history"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/people/$id")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    TABS.includes(search.tab as Tab) && search.tab !== "overview" ? { tab: search.tab as Tab } : {},
  component: PersonPage,
});

function PersonPage() {
  const { id } = Route.useParams();
  const { tab = "overview" } = Route.useSearch();
  const navigate = useNavigate({ from: "/people/$id" });
  const person = useOp("person.get", { id, includeDeleted: true });

  if (person.isPending) {
    return (
      <div className="mx-auto grid w-full grid-cols-1 max-w-7xl gap-4" aria-busy="true">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-full" />
          <div className="grid gap-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (person.isError) {
    const notFound =
      person.error instanceof OperationCallError && person.error.code === "not_found";
    return (
      <EmptyState
        icon={UserXIcon}
        title={notFound ? "Person not found" : "Could not load this person"}
        description={
          notFound ? "They may have been purged from Trash." : errorMessage(person.error)
        }
        action={
          <Button asChild variant="outline">
            <Link to="/people">Back to People</Link>
          </Button>
        }
        className="mx-auto max-w-xl"
      />
    );
  }

  return (
    <PersonRecord
      person={person.data}
      tab={tab}
      onTabChange={(next) =>
        navigate({ search: next === "overview" ? {} : { tab: next as Tab }, replace: true })
      }
    />
  );
}

type PersonData = NonNullable<ReturnType<typeof useOp<"person.get">>["data"]>;

function PersonRecord({
  person,
  tab,
  onTabChange,
}: {
  person: PersonData;
  tab: Tab;
  onTabChange: (tab: string) => void;
}) {
  const ref: RecordRef = { object: "person", id: person.id };
  const deleted = Boolean(person.deletedAt);
  const timeline = useTimeline(ref);
  const composer = useCreateActivity(ref);
  const tasks = useRecordTasks(ref);
  const taskActions = useTaskActions(ref);
  const affiliations = usePersonAffiliations(person);
  const history = useRecordHistory(ref);
  const restore = useOpMutation("person.restore");

  const subtitle =
    person.primaryAffiliation &&
    [person.primaryAffiliation.title, person.primaryAffiliation.organisationName]
      .filter(Boolean)
      .join(" at ");

  async function onRestore() {
    try {
      await restore.mutateAsync({ id: person.id });
      toast.success(`Restored ${person.displayName}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const openTasks = tasks.data.filter((t) => t.status === "open").length;

  return (
    <div className="grid grid-cols-1 gap-2">
      <Link
        to="/people"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        People
      </Link>
      <RecordLayout
        title={person.displayName}
        subtitle={subtitle || person.emails.find((e) => e.primary)?.email}
        actions={
          <>
            <DisabledAction
              label="Ask AI"
              icon={<SparklesIcon />}
              reason="The AI assistant arrives in a later stage."
            />
            {/* TODO(stage-1-wire): open task quick-add (task.create) linked to this person. */}
            <DisabledAction label="Task" icon={<PlusIcon />} reason="Tasks are coming soon." />
            {!deleted && <DeleteAction id={person.id} name={person.displayName} />}
          </>
        }
        banner={
          deleted && (
            <div
              className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
              role="status"
              data-testid="trash-banner"
            >
              <Trash2Icon className="size-4 text-destructive" aria-hidden />
              <span className="flex-1">
                In Trash since {formatDate(person.deletedAt)}. Restore within 30 days to keep them.
              </span>
              <Button size="sm" variant="outline" onClick={onRestore} disabled={restore.isPending}>
                <RotateCcwIcon />
                Restore
              </Button>
            </div>
          )
        }
        tab={tab}
        onTabChange={onTabChange}
        tabs={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <>
                {!deleted && (
                  <ActivityComposer onSubmit={composer.create} isPending={composer.isPending} />
                )}
                <Timeline
                  items={timeline.data}
                  isPending={timeline.isPending}
                  wired={timeline.wired}
                  limit={10}
                />
              </>
            ),
          },
          {
            value: "timeline",
            label: "Timeline",
            content: (
              <>
                {!deleted && (
                  <ActivityComposer onSubmit={composer.create} isPending={composer.isPending} />
                )}
                <Timeline
                  items={timeline.data}
                  isPending={timeline.isPending}
                  wired={timeline.wired}
                />
              </>
            ),
          },
          {
            value: "tasks",
            label: "Tasks",
            count: openTasks,
            content: (
              <TaskList
                tasks={tasks.data}
                isPending={tasks.isPending}
                wired={tasks.wired}
                onToggle={
                  taskActions.setDone &&
                  ((taskId, done) => void taskActions.setDone?.(taskId, done))
                }
              />
            ),
          },
          {
            value: "history",
            label: "History",
            content: (
              <HistoryList
                object={personObject}
                entries={history.data}
                isPending={history.isPending}
                wired={history.wired}
              />
            ),
          },
        ]}
        side={
          <>
            <PersonDetailsCard person={person} readOnly={deleted} />
            <AffiliationsCard
              affiliations={affiliations.data}
              isPending={affiliations.isPending}
              wired={affiliations.wired}
            />
            <TasksCard
              tasks={tasks.data}
              isPending={tasks.isPending}
              wired={tasks.wired}
              onToggle={
                taskActions.setDone && ((taskId, done) => void taskActions.setDone?.(taskId, done))
              }
              onAdd={null}
            />
          </>
        }
      />
    </div>
  );
}

/** A header action that is not available yet: disabled, with the reason in a tooltip. */
function DisabledAction({
  label,
  icon,
  reason,
}: {
  label: string;
  icon: ReactNode;
  reason: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled rather than disabled, so it stays focusable and the tooltip shows. */}
        <Button
          variant="outline"
          size="sm"
          aria-disabled="true"
          aria-description={reason}
          className="cursor-not-allowed opacity-50"
          onClick={(event) => event.preventDefault()}
        >
          {icon}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

function DeleteAction({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const remove = useOpMutation("person.delete");
  const restore = useOpMutation("person.restore");
  const merge = useMergeAction("person", id);

  async function run() {
    try {
      await remove.mutateAsync({ id });
      setOpen(false);
      toast.success(`Moved ${name} to Trash`, {
        action: { label: "Undo", onClick: () => restore.mutate({ id }) },
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            className="ml-auto sm:ml-0"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {merge.item}
          <DropdownMenuItem variant="destructive" onSelect={() => setOpen(true)}>
            <Trash2Icon />
            Delete person
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {merge.dialog}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They move to Trash and can be restored for 30 days. Their activities and tasks are
              kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
              disabled={remove.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
