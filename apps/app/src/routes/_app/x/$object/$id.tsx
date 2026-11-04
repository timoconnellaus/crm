// Generic record page for an extension object: RecordLayout with Overview (its fields, from the
// field registry, edited with the field widgets), Timeline and History tabs, and Trash.
import { Button } from "@crm/ui/components/button";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BoxIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { SimilarRecordsCard } from "#/components/ai/similar-records";
import { RecordSummaryCard } from "#/components/ai/summary";
import { EmptyState } from "#/components/empty-state";
import { FieldsCard } from "#/components/fields/fields-card";
import { useRecordHistory, useTimeline } from "#/components/record/adapters";
import { HistoryList } from "#/components/record/history";
import { RecordLayout, RecordLayoutSkeleton } from "#/components/record/record-layout";
import { isRecordViewTab, useRecordViews } from "#/components/record/record-views";
import { Timeline } from "#/components/record/timeline";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import {
  fieldsByExtension,
  type ObjectInfo,
  toObjectDefinition,
  useObjectInfo,
} from "#/lib/schema";

const TABS = ["overview", "timeline", "history"] as const;
type Tab = (typeof TABS)[number] | `x:${string}`;

export const Route = createFileRoute("/_app/x/$object/$id")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    (TABS.includes(search.tab as (typeof TABS)[number]) && search.tab !== "overview") ||
    isRecordViewTab(search.tab)
      ? { tab: search.tab as Tab }
      : {},
  component: ExtensionRecordPage,
});

function ExtensionRecordPage() {
  const { object: name, id } = Route.useParams();
  const { object, isPending } = useObjectInfo(name);
  if (isPending) return <RecordLayoutSkeleton />;
  if (!object) {
    return (
      <EmptyState
        icon={BoxIcon}
        title="No such object"
        description={`${name} is not an object in this CRM.`}
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
      />
    );
  }
  return <RecordPage key={`${name}:${id}`} info={object} id={id} />;
}

function RecordPage({ info, id }: { info: ObjectInfo; id: string }) {
  const { tab = "overview" } = Route.useSearch();
  const navigate = useNavigate({ from: "/x/$object/$id" });
  const record = useOp("record.get", { object: info.name, id });
  const timeline = useTimeline(info.name, id);
  const recordViews = useRecordViews(info.name, id);
  const history = useRecordHistory(info.name, id);
  const definition = useMemo(() => toObjectDefinition(info), [info]);
  const remove = useOpMutation("record.delete", { invalidates: ["record."] });

  if (record.isPending) return <RecordLayoutSkeleton />;
  if (record.error || !record.data) {
    return (
      <EmptyState
        icon={BoxIcon}
        title={`${info.label} not found`}
        description={record.error ? errorMessage(record.error) : undefined}
        action={
          <Button asChild variant="outline">
            <Link to="/x/$object" params={{ object: info.name }}>
              Back to {(info.plural ?? info.label).toLowerCase()}
            </Link>
          </Button>
        }
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
      />
    );
  }
  const data = record.data;
  const groups = fieldsByExtension(info);
  const own = groups.find(([ext]) => ext === info.extension)?.[1] ?? [];
  const others = groups.filter(([ext]) => ext !== info.extension);

  async function onDelete() {
    try {
      await remove.mutateAsync({ object: info.name, id });
      toast.success(`${info.label} moved to Trash`);
      navigate({ to: "/x/$object", params: { object: info.name } });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <RecordLayout
      back={{ to: "/x/$object", params: { object: info.name }, label: info.plural ?? info.label }}
      squareAvatar
      title={data.title ?? "(untitled)"}
      subtitle={
        <Link to="/x/$object" params={{ object: info.name }} className="hover:underline">
          {info.label}
        </Link>
      }
      actions={
        <Button variant="outline" onClick={onDelete} disabled={remove.isPending}>
          <Trash2Icon />
          Delete
        </Button>
      }
      tab={tab}
      onTabChange={(next) =>
        navigate({ search: next === "overview" ? {} : { tab: next as Tab }, replace: true })
      }
      tabs={[
        {
          value: "overview",
          label: "Overview",
          content: (
            <>
              <FieldsCard
                title="Details"
                object={info.name}
                id={id}
                fields={own}
                values={data.values}
                testId="record-fields"
              />
              {others.map(([extension, fields]) => (
                <FieldsCard
                  key={extension}
                  title={extension}
                  object={info.name}
                  id={id}
                  fields={fields}
                  values={data.values}
                  testId={`extension-fields-${extension}`}
                />
              ))}
            </>
          ),
        },
        {
          value: "timeline",
          label: "Timeline",
          content: (
            <Timeline
              items={timeline.data}
              isPending={timeline.isPending}
              error={timeline.error}
              hasMore={timeline.hasMore}
              onLoadMore={timeline.loadMore}
              isLoadingMore={timeline.isLoadingMore}
              loadMoreFailed={timeline.loadMoreFailed}
            />
          ),
        },
        {
          value: "history",
          label: "History",
          content: (
            <HistoryList
              object={definition}
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
          {info.name === "deals.deal" && <RecordSummaryCard object="deals.deal" id={id} />}
          {recordViews.panels}
          <dl className="grid gap-1 rounded-lg border p-4 text-sm">
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDateTime(data.createdAt)}</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{formatDateTime(data.updatedAt)}</dd>
            <dt className="text-muted-foreground">Extension</dt>
            <dd>{info.extension}</dd>
          </dl>
          {info.name === "deals.deal" && <SimilarRecordsCard object="deals.deal" id={id} />}
        </>
      }
    />
  );
}
