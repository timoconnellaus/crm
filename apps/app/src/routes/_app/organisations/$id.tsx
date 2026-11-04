// Organisation record page, layout B like the person page: header (logo, name, industry, primary
// domain) with actions, tabs (Overview, Timeline, People, Tasks, History), and details, people,
// related organisations and tasks in the side panel. Deleted organisations stay viewable here
// with a Restore banner.
import { organisationObject } from "@crm/core/client";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crm/ui/components/dropdown-menu";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Building2Icon,
  EllipsisIcon,
  ExternalLinkIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAppCommands } from "#/components/app-commands";
import { PendingChangesBadge } from "#/components/approvals/pending-badge";
import {
  ManualAutomationButtons,
  RecordAutomationsCard,
} from "#/components/automations/record-automations";
import { EmptyState } from "#/components/empty-state";
import { ExtensionFieldsCards } from "#/components/fields/fields-card";
import { useMergeAction } from "#/components/merge/merge-action";
import { faviconUrl } from "#/components/organisations/config";
import { OrganisationDetailsCard } from "#/components/organisations/organisation-details-card";
import {
  OrganisationFamilyCard,
  OrganisationPeopleCard,
  OrganisationPeopleList,
} from "#/components/organisations/organisation-people";
import {
  useChildOrganisations,
  useOrganisationPeople,
} from "#/components/organisations/record-adapters";
import {
  type ActivityType,
  timelineQueryOptions,
  useLogActivity,
  useRecordHistory,
  useRecordTasks,
  useTaskActions,
  useTimeline,
} from "#/components/record/adapters";
import { HistoryList } from "#/components/record/history";
import { RecordLayout, RecordLayoutSkeleton } from "#/components/record/record-layout";
import { isRecordViewTab, useRecordViews } from "#/components/record/record-views";
import { TaskList, TasksCard } from "#/components/record/tasks";
import { ActivityComposer, Timeline, TimelineFilter } from "#/components/record/timeline";
import { formatDate } from "#/lib/format";
import { callOp, OperationCallError } from "#/lib/operations";
import { errorMessage, opKey, useOp, useOpMutation } from "#/lib/query";

const TABS = ["overview", "timeline", "people", "tasks", "history"] as const;
type Tab = (typeof TABS)[number] | `x:${string}`;

export const Route = createFileRoute("/_app/organisations/$id")({
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
      queryKey: opKey("organisation.get", input),
      queryFn: () => callOp("organisation.get", input),
    });
    void context.queryClient.ensureInfiniteQueryData(
      timelineQueryOptions("organisation", params.id),
    );
  },
  component: OrganisationPage,
});

function OrganisationPage() {
  const { id } = Route.useParams();
  const { tab = "overview" } = Route.useSearch();
  const navigate = useNavigate({ from: "/organisations/$id" });
  const organisation = useOp("organisation.get", { id, includeDeleted: true });

  if (organisation.isPending) return <RecordLayoutSkeleton />;
  if (organisation.isError) {
    const notFound =
      organisation.error instanceof OperationCallError && organisation.error.code === "not_found";
    return (
      <EmptyState
        icon={Building2Icon}
        title={notFound ? "Organisation not found" : "Could not load this organisation"}
        description={
          notFound ? "It may have been purged from Trash." : errorMessage(organisation.error)
        }
        action={
          <Button asChild variant="outline">
            <Link to="/organisations">Back to Organisations</Link>
          </Button>
        }
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
      />
    );
  }

  return (
    <OrganisationRecord
      organisation={organisation.data}
      tab={tab}
      onTabChange={(next) =>
        navigate({ search: next === "overview" ? {} : { tab: next as Tab }, replace: true })
      }
    />
  );
}

type OrganisationData = NonNullable<ReturnType<typeof useOp<"organisation.get">>["data"]>;

function OrganisationRecord({
  organisation: org,
  tab,
  onTabChange,
}: {
  organisation: OrganisationData;
  tab: Tab;
  onTabChange: (tab: string) => void;
}) {
  const deleted = Boolean(org.deletedAt);
  const [types, setTypes] = useState<ActivityType[]>([]);
  const timeline = useTimeline("organisation", org.id, { types });
  const recordViews = useRecordViews("organisation", org.id);
  const composer = useLogActivity("organisation", org.id);
  const tasks = useRecordTasks("organisation", org.id);
  const taskActions = useTaskActions("organisation", org.id);
  const history = useRecordHistory("organisation", org.id);
  const { create } = useAppCommands();
  const people = useOrganisationPeople(org.id);
  const children = useChildOrganisations(org.id);
  const restore = useOpMutation("organisation.restore", { invalidates: ["affiliation."] });
  const mergedInto = useOp(
    "organisation.get",
    { id: org.mergedIntoId ?? "org_", includeDeleted: true },
    { enabled: Boolean(org.mergedIntoId) },
  );

  const primaryDomain = org.domains.find((d) => d.primary)?.domain ?? org.domains[0]?.domain;
  const currentPeople = people.data.filter((a) => a.current).length;
  const openTasks = tasks.data.filter((t) => t.status === "open").length;
  const toggleTask = deleted ? null : taskActions.setDone;
  const addTask = deleted
    ? null
    : () => create("task", { link: { object: "organisation", id: org.id, title: org.name } });

  async function onRestore() {
    try {
      await restore.mutateAsync({ id: org.id });
      toast.success(`Restored ${org.name}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2">
      {org.industry && <span>{org.industry}</span>}
      {org.industry && primaryDomain && <span aria-hidden>·</span>}
      {primaryDomain && (
        <a
          href={`https://${primaryDomain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          data-testid="primary-domain"
        >
          {primaryDomain}
          <ExternalLinkIcon className="size-3" aria-hidden />
        </a>
      )}
    </span>
  );

  const timelineContent = (limit?: number) => (
    <>
      {!deleted && <ActivityComposer onSubmit={composer.log} isPending={composer.isPending} />}
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

  return (
    <RecordLayout
      back={{ to: "/organisations", label: "Organisations" }}
      squareAvatar
      badge={<PendingChangesBadge object="organisation" id={org.id} />}
      title={org.name}
      subtitle={org.industry || primaryDomain ? subtitle : undefined}
      avatarUrl={faviconUrl(primaryDomain)}
      actions={
        !deleted && (
          <>
            <ManualAutomationButtons object="organisation" id={org.id} />
            {addTask && (
              <Button variant="outline" size="sm" onClick={addTask} aria-keyshortcuts="c">
                <PlusIcon />
                Task
              </Button>
            )}
            <OrganisationActions id={org.id} name={org.name} />
          </>
        )
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
              {org.mergedIntoId ? (
                <>
                  Merged into{" "}
                  <Link
                    to="/organisations/$id"
                    params={{ id: org.mergedIntoId }}
                    className="font-medium underline"
                  >
                    {mergedInto.data?.name ?? "another organisation"}
                  </Link>{" "}
                  on {formatDate(org.deletedAt)}, and in Trash.
                </>
              ) : (
                <>In Trash since {formatDate(org.deletedAt)}.</>
              )}{" "}
              Restore within 30 days to keep it.
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
        { value: "overview", label: "Overview", content: timelineContent(10) },
        { value: "timeline", label: "Timeline", content: timelineContent() },
        {
          value: "people",
          label: "People",
          count: currentPeople,
          content: (
            <OrganisationPeopleList affiliations={people.data} isPending={people.isPending} />
          ),
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
                onToggle={toggleTask}
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
              object={organisationObject}
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
          <OrganisationDetailsCard organisation={org} readOnly={deleted} />
          {recordViews.panels}
          <RecordAutomationsCard object={"organisation"} id={org.id} />
          <ExtensionFieldsCards object="organisation" id={org.id} readOnly={deleted} />
          <OrganisationPeopleCard
            affiliations={people.data}
            isPending={people.isPending}
            onShowAll={() => onTabChange("people")}
          />
          <OrganisationFamilyCard
            parent={
              org.parentId ? { id: org.parentId, name: org.parentName ?? org.parentId } : null
            }
            childOrganisations={children.data}
            isPending={children.isPending}
          />
          <TasksCard
            tasks={tasks.data}
            isPending={tasks.isPending}
            error={tasks.error}
            onToggle={toggleTask}
            onAdd={addTask}
          />
        </>
      }
    />
  );
}

function OrganisationActions({ id, name }: { id: string; name: string }) {
  const [deleting, setDeleting] = useState(false);
  const merge = useMergeAction("organisation", id);
  const remove = useOpMutation("organisation.delete");
  const restore = useOpMutation("organisation.restore");

  async function run() {
    try {
      await remove.mutateAsync({ id });
      setDeleting(false);
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
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2Icon />
            Delete organisation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {merge.dialog}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It moves to Trash and can be restored for 30 days. Its domains become free for other
              organisations. Its people, activities and tasks are kept.
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
