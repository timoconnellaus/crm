// Approvals inbox (ADR 0022, stage 2 mockup): change sets agents queued for review, newest first.
// "Awaiting review" lists sets with pending actions; a set stays on screen after it is decided
// so its outcome (cascades, failures) can be read. "History" lists every set, collapsed.
// `?set=chs_…` (from a record's pending badge) outlines and scrolls to one set.

import { Skeleton } from "@crm/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCheckIcon, HistoryIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ChangeSetCard } from "#/components/approvals/change-set-card";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp } from "#/lib/query";

interface ApprovalsSearch {
  tab?: "history";
  set?: string;
}

export const Route = createFileRoute("/_app/approvals")({
  validateSearch: (search: Record<string, unknown>): ApprovalsSearch => ({
    ...(search.tab === "history" ? { tab: "history" as const } : {}),
    ...(typeof search.set === "string" && /^chs_[\w-]{1,60}$/.test(search.set)
      ? { set: search.set }
      : {}),
  }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { tab = "awaiting", set } = Route.useSearch();
  const navigate = useNavigate({ from: "/approvals" });
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Approvals"
      width="lg"
      description="Changes waiting for you. Agents kept working on top of these as if they'd been applied."
      tabs={
        <Tabs
          value={tab}
          onValueChange={(next) =>
            navigate({ search: next === "history" ? { tab: "history" } : {}, replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="awaiting">Awaiting review</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {tab === "history" ? (
        <HistoryTab highlight={set} isAdmin={isAdmin} />
      ) : (
        <AwaitingTab highlight={set} isAdmin={isAdmin} />
      )}
    </PageLayout>
  );
}

function AwaitingTab({ highlight, isAdmin }: { highlight?: string; isAdmin: boolean }) {
  const list = useOp(
    "approval.list",
    { status: "awaiting_review", limit: 50 },
    { refetchOnWindowFocus: true, staleTime: 0 },
  );
  // Sets seen while this page is open stay listed once decided, showing their outcome.
  const [seen, setSeen] = useState<string[]>(highlight ? [highlight] : []);
  useEffect(() => {
    const ids = list.data?.items.map((s) => s.id) ?? [];
    setSeen((current) => {
      const next = [...new Set([...current, ...ids])].sort().reverse();
      return next.length === current.length && next.every((id, i) => id === current[i])
        ? current
        : next;
    });
  }, [list.data]);

  if (list.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (list.isError) {
    return <EmptyState title="Could not load approvals" description={errorMessage(list.error)} />;
  }
  if (!seen.length) {
    return (
      <EmptyState
        icon={CheckCheckIcon}
        title="Nothing waiting for review"
        description="When an agent queues a change that needs a person, it shows up here."
      />
    );
  }
  return (
    <div className="grid gap-4" data-testid="awaiting-review">
      {seen.map((id) => {
        const summary = list.data.items.find((s) => s.id === id);
        return (
          <ChangeSetCard
            key={id}
            changeSetId={id}
            {...(summary ? { summary } : {})}
            highlighted={id === highlight}
            isAdmin={isAdmin}
          />
        );
      })}
    </div>
  );
}

function HistoryTab({ highlight, isAdmin }: { highlight?: string; isAdmin: boolean }) {
  const list = useOp("approval.list", { status: "all", limit: 100 }, { staleTime: 0 });
  if (list.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (list.isError) {
    return <EmptyState title="Could not load approvals" description={errorMessage(list.error)} />;
  }
  const sets = list.data.items.filter((s) => s.status !== "empty");
  if (!sets.length) {
    return <EmptyState icon={HistoryIcon} title="No change sets yet" />;
  }
  return (
    <div className="grid gap-3" data-testid="approval-history">
      {sets.map((s) => (
        <ChangeSetCard
          key={s.id}
          changeSetId={s.id}
          summary={s}
          collapsible
          highlighted={s.id === highlight}
          isAdmin={isAdmin}
        />
      ))}
    </div>
  );
}
