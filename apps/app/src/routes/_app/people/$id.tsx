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
import { Tooltip, TooltipContent, TooltipTrigger } from "@crm/ui/components/tooltip";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  UserXIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useAppCommands } from "#/components/app-commands";
import { PendingChangesBadge } from "#/components/approvals/pending-badge";
import { EmptyState } from "#/components/empty-state";
import { ExtensionFieldsCards } from "#/components/fields/fields-card";
import { useMergeAction } from "#/components/merge/merge-action";
import { PersonDetailsCard } from "#/components/people/person-details-card";
import {
  type ActivityType,
  type AffiliationItem,
  timelineQueryOptions,
  useAffiliations,
  useLogActivity,
  useRecordHistory,
  useRecordTasks,
  useTaskActions,
  useTimeline,
} from "#/components/record/adapters";
import {
  AddAffiliationDialog,
  ChangeJobDialog,
  EndAffiliationDialog,
} from "#/components/record/affiliation-dialogs";
import { AffiliationsCard } from "#/components/record/affiliations-card";
import { HistoryList } from "#/components/record/history";
import { RecordLayout, RecordLayoutSkeleton } from "#/components/record/record-layout";
import { isRecordViewTab, useRecordViews } from "#/components/record/record-views";
import { TaskList, TasksCard } from "#/components/record/tasks";
import { ActivityComposer, Timeline, TimelineFilter } from "#/components/record/timeline";
import { formatDate } from "#/lib/format";
import { callOp, OperationCallError } from "#/lib/operations";
import { errorMessage, opKey, useOp, useOpMutation } from "#/lib/query";

const TABS = ["overview", "timeline", "tasks", "history"] as const;
type Tab = (typeof TABS)[number] | `x:${string}`;

export const Route = createFileRoute("/_app/people/$id")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    (TABS.includes(search.tab as (typeof TABS)[number]) && search.tab !== "overview") ||
    isRecordViewTab(search.tab)
      ? { tab: search.tab as Tab }
      : {},
  // Intent preloading: hovering a link to this record warms the record and its timeline.
  loader: ({ context, params }) => {
    if (typeof window === "undefined") return;
    const input = { id: params.id, includeDeleted: true };
    void context.queryClient.ensureQueryData({
      queryKey: opKey("person.get", input),
      queryFn: () => callOp("person.get", input),
    });
    void context.queryClient.ensureInfiniteQueryData(timelineQueryOptions("person", params.id));
  },
  component: PersonPage,
});

function PersonPage() {
  const { id } = Route.useParams();
  const { tab = "overview" } = Route.useSearch();
  const navigate = useNavigate({ from: "/people/$id" });
  const person = useOp("person.get", { id, includeDeleted: true });

  if (person.isPending) return <RecordLayoutSkeleton />;
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
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
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
  const deleted = Boolean(person.deletedAt);
  const [types, setTypes] = useState<ActivityType[]>([]);
  const timeline = useTimeline("person", person.id, { types });
  const recordViews = useRecordViews("person", person.id);
  const composer = useLogActivity("person", person.id);
  const tasks = useRecordTasks("person", person.id);
  const taskActions = useTaskActions("person", person.id);
  const affiliations = useAffiliations("person", person.id);
  const history = useRecordHistory("person", person.id);
  const restore = useOpMutation("person.restore");
  const { create } = useAppCommands();
  const [dialog, setDialog] = useState<"add" | "changeJob" | null>(null);
  const [ending, setEnding] = useState<AffiliationItem | null>(null);
  const addTask = deleted
    ? null
    : () =>
        create("task", { link: { object: "person", id: person.id, title: person.displayName } });
  const primary = affiliations.data.find((a) => a.primary) ?? null;
  const currentOrg =
    primary?.current && primary.organisationName
      ? {
          object: "organisation" as const,
          id: primary.organisationId,
          title: primary.organisationName,
        }
      : null;
  const toggle = deleted ? null : taskActions.setDone;
  const timelinePanel = (limit?: number) => (
    <>
      {!deleted && (
        <ActivityComposer
          onSubmit={composer.log}
          isPending={composer.isPending}
          alsoOn={currentOrg}
        />
      )}
      <TimelineFilter value={types} onChange={setTypes} />
      <Timeline
        items={timeline.data}
        isPending={timeline.isPending}
        error={timeline.error}
        hasMore={timeline.hasMore}
        onLoadMore={timeline.loadMore}
        isLoadingMore={timeline.isLoadingMore}
        loadMoreFailed={timeline.loadMoreFailed}
        emptyTitle={types.length ? "No matching activity" : "No activity yet"}
        {...(limit ? { limit } : {})}
      />
    </>
  );

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
    <>
      <RecordLayout
        back={{ to: "/people", label: "People" }}
        badge={<PendingChangesBadge object="person" id={person.id} />}
        title={person.displayName}
        subtitle={subtitle || person.emails.find((e) => e.primary)?.email}
        actions={
          <>
            <DisabledAction
              label="Ask AI"
              icon={<SparklesIcon />}
              reason="The AI assistant arrives in a later stage."
            />
            {addTask && (
              <Button variant="outline" size="sm" onClick={addTask} aria-keyshortcuts="c">
                <PlusIcon />
                Task
              </Button>
            )}
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
            content: timelinePanel(10),
          },
          {
            value: "timeline",
            label: "Timeline",
            content: timelinePanel(),
          },
          {
            value: "tasks",
            label: "Tasks",
            count: openTasks,
            content: (
              <>
                {addTask && (
                  <Button variant="outline" size="sm" className="w-fit" onClick={addTask}>
                    <PlusIcon />
                    Add task
                  </Button>
                )}
                <TaskList
                  tasks={tasks.data}
                  isPending={tasks.isPending}
                  error={tasks.error}
                  onToggle={toggle}
                  emptyTitle="No tasks"
                />
              </>
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
                error={history.error}
                hasMore={history.hasMore}
                onLoadMore={history.loadMore}
                isLoadingMore={history.isLoadingMore}
                loadMoreFailed={history.loadMoreFailed}
              />
            ),
          },
          ...recordViews.tabs,
        ]}
        side={
          <>
            <PersonDetailsCard person={person} readOnly={deleted} />
            {recordViews.panels}
            <ExtensionFieldsCards object="person" id={person.id} readOnly={deleted} />
            <AffiliationsCard
              object="person"
              affiliations={affiliations.data}
              isPending={affiliations.isPending}
              error={affiliations.error}
              onAdd={deleted ? null : () => setDialog("add")}
              onChangeJob={deleted ? null : () => setDialog("changeJob")}
              onEnd={deleted ? null : setEnding}
            />
            <TasksCard
              tasks={tasks.data}
              isPending={tasks.isPending}
              error={tasks.error}
              onToggle={toggle}
              onAdd={addTask}
            />
          </>
        }
      />
      <AddAffiliationDialog
        personId={person.id}
        personName={person.displayName}
        open={dialog === "add"}
        onOpenChange={(open) => setDialog(open ? "add" : null)}
      />
      <ChangeJobDialog
        personId={person.id}
        personName={person.displayName}
        current={primary}
        open={dialog === "changeJob"}
        onOpenChange={(open) => setDialog(open ? "changeJob" : null)}
      />
      <EndAffiliationDialog
        affiliation={ending}
        onOpenChange={(open) => !open && setEnding(null)}
      />
    </>
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
