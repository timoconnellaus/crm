// Automations: every automation the installed extensions declare (automation.list), with its
// status (Active, Disabled, Paused, Killed), trigger, last run, and runs and errors in the last 7
// days. A banner says when the admin kill switch is engaged.
import { Badge } from "@crm/ui/components/badge";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { type AutomationItem, useAutomations } from "#/components/automations/hooks";
import { KillSwitchBanner } from "#/components/automations/kill-switch-banner";
import { compactRelative, RUN_STATUS_LABELS } from "#/components/automations/model";
import { StatusPill } from "#/components/automations/parts";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { type InfiniteSource, VirtualFeed } from "#/components/layout/infinite";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";

export const Route = createFileRoute("/_app/automations/")({ component: AutomationsPage });

/** The whole list comes in one call: nothing more to load. */
const COMPLETE: InfiniteSource = {
  hasNextPage: false,
  isFetching: false,
  isFetchingNextPage: false,
  fetchNextPage: () => undefined,
};

function AutomationsPage() {
  const { isAdmin } = Route.useRouteContext();
  const list = useAutomations();
  const items = list.data?.items ?? [];
  return (
    <PageLayout
      title="Automations"
      width="xl"
      count={
        <PageCount
          value={list.data ? items.length : undefined}
          isPending={list.isPending}
          noun="automations"
        />
      }
      description="What your extensions do on their own when records change, on a schedule or on a button. Claude writes them; you approve them."
    >
      {list.data?.killSwitch && <KillSwitchBanner isAdmin={isAdmin} />}
      {list.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : list.error ? (
        <ErrorState
          title="Could not load automations"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : !items.length ? (
        <EmptyState
          icon={WorkflowIcon}
          title="No automations yet"
          description="Ask Claude to automate something, e.g. “when a deal is won, create onboarding tasks”."
        />
      ) : (
        <VirtualFeed
          as="ul"
          label="Automations"
          items={items}
          getKey={(a) => a.id}
          estimateSize={76}
          source={COMPLETE}
          className="rounded-md border"
          itemClassName="border-b last:border-b-0"
          itemTestId="automation-item"
          renderItem={(item) => <AutomationRow item={item} />}
        />
      )}
    </PageLayout>
  );
}

function AutomationRow({ item }: { item: AutomationItem }) {
  return (
    <Link
      to="/automations/$id"
      params={{ id: item.id }}
      className="grid gap-1 px-3 py-3 text-sm hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
    >
      <div className="grid min-w-0 gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{item.label}</span>
          <StatusPill status={item.status} />
          {item.manual && (
            <Badge variant="outline">{item.manual.bulk ? "Bulk action" : "Button"}</Badge>
          )}
        </div>
        <span className="truncate text-muted-foreground">{item.triggerText}</span>
        <span className="truncate text-xs text-muted-foreground">
          {item.extensionLabel ?? item.extensionId} extension
          {item.pausedReason ? ` · ${item.pausedReason}` : ""}
        </span>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:justify-end sm:text-right">
        <div>
          <dt className="sr-only">Last run</dt>
          <dd title={item.lastRunAt ? formatDateTime(item.lastRunAt) : undefined}>
            {item.lastRunAt
              ? `Last run ${compactRelative(item.lastRunAt)}${item.lastRunStatus ? ` · ${RUN_STATUS_LABELS[item.lastRunStatus].toLowerCase()}` : ""}`
              : "Never run"}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Runs in the last 7 days</dt>
          <dd>{item.runs7d.toLocaleString()} runs (7d)</dd>
        </div>
        <div>
          <dt className="sr-only">Errors in the last 7 days</dt>
          <dd
            className={item.errors7d > 0 ? "text-red-700 dark:text-red-400" : undefined}
            data-testid="automation-errors"
          >
            {item.errors7d.toLocaleString()} {item.errors7d === 1 ? "error" : "errors"}
          </dd>
        </div>
      </dl>
    </Link>
  );
}
