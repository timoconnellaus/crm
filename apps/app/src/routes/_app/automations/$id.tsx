// An automation's page, in the approved reference design's layout
// (docs/stages/assets/05-automation-page.html): header (name, provenance line, status pill, Test
// on a record…, Pause / Resume, Ask the assistant), tabs Overview / Runs (n) / Code / Versions.
// `?tab=runs&run=arn_…` opens a run's detail (notifications link there).
import type { AutomationTestReport } from "@crm/core";
import { Button } from "@crm/ui/components/button";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@crm/ui/components/tooltip";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, PauseIcon, PlayIcon, PlugIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { connectionSlots, connectionsBanner } from "#/components/automations/connections-model";
import {
  type AutomationDetailData,
  useAutomation,
  useSetEnabled,
} from "#/components/automations/hooks";
import { KillSwitchBanner } from "#/components/automations/kill-switch-banner";
import { asTestReport, provenanceLine } from "#/components/automations/model";
import { OverviewTab } from "#/components/automations/overview";
import { StatusPill } from "#/components/automations/parts";
import { RunsTab } from "#/components/automations/runs-tab";
import { CodeTab, VersionsTab } from "#/components/automations/source-tabs";
import { TestButton } from "#/components/automations/test-dialog";
import { EmptyState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatRelative } from "#/lib/format";
import { errorMessage } from "#/lib/query";

const TABS = ["overview", "runs", "code", "versions"] as const;
type Tab = (typeof TABS)[number];

interface AutomationSearch {
  tab?: Exclude<Tab, "overview">;
  run?: string;
}

export const Route = createFileRoute("/_app/automations/$id")({
  validateSearch: (search: Record<string, unknown>): AutomationSearch => ({
    ...(TABS.includes(search.tab as Tab) && search.tab !== "overview"
      ? { tab: search.tab as Exclude<Tab, "overview"> }
      : {}),
    ...(typeof search.run === "string" && /^arn_[0-9A-Z]{26}$/.test(search.run)
      ? { run: search.run }
      : {}),
  }),
  component: AutomationPage,
});

function AutomationPage() {
  const { id } = Route.useParams();
  const query = useAutomation(id);
  if (query.isPending) {
    return (
      <div className="grid gap-4 p-6" aria-busy="true" data-testid="automation-skeleton">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (query.error || !query.data) {
    return (
      <EmptyState
        icon={WorkflowIcon}
        title="Automation not found"
        description={query.error ? errorMessage(query.error) : undefined}
        action={
          <Button asChild variant="outline">
            <Link to="/automations">Back to automations</Link>
          </Button>
        }
        className="mx-4 my-6 sm:mx-auto sm:max-w-xl"
      />
    );
  }
  return <AutomationView key={id} detail={query.data} />;
}

function AutomationView({ detail }: { detail: AutomationDetailData }) {
  const { tab = "overview", run } = Route.useSearch();
  const { isAdmin } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/automations/$id" });
  const [tested, setTested] = useState<AutomationTestReport | null>(null);
  const report = tested ?? asTestReport(detail.lastTest);
  const banner = connectionsBanner(detail.pausedReason, connectionSlots(detail.connections));

  const go = (next: Tab, runId?: string) =>
    navigate({
      search: {
        ...(next === "overview" ? {} : { tab: next }),
        ...(runId ? { run: runId } : {}),
      },
      replace: next === tab,
    });

  return (
    <PageLayout
      title={detail.label}
      back={{ to: "/automations", label: "Automations" }}
      description={
        <span data-testid="automation-provenance">{provenanceLine(detail, formatRelative)}</span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2" data-name="automation header">
          <StatusPill status={detail.status} />
          <TestButton
            detail={detail}
            onReport={(next) => {
              setTested(next);
              if (tab !== "overview") go("overview");
            }}
          />
          <PauseButton detail={detail} />
          <AskAssistantButton />
        </div>
      }
      tabs={
        <Tabs value={tab} onValueChange={(next) => go(next as Tab)}>
          <TabsList variant="line" className="h-9 w-full justify-start gap-4 overflow-x-auto p-0">
            <TabsTrigger value="overview" className="flex-none px-0">
              Overview
            </TabsTrigger>
            <TabsTrigger value="runs" className="flex-none px-0">
              Runs ({detail.runCount.toLocaleString()})
            </TabsTrigger>
            <TabsTrigger value="code" className="flex-none px-0">
              Code
            </TabsTrigger>
            <TabsTrigger value="versions" className="flex-none px-0">
              Versions
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
      scrollId={`automation-${tab}`}
    >
      {detail.killSwitch && <KillSwitchBanner isAdmin={isAdmin} />}
      {banner && detail.status === "paused" ? (
        <ConnectionsBanner
          banner={banner}
          detail={detail}
          onBind={() => {
            if (tab !== "overview") go("overview");
            // After the tab renders: the Permissions card holds the pickers.
            requestAnimationFrame(() =>
              document
                .getElementById("card-permissions-title")
                ?.scrollIntoView({ block: "start", behavior: "smooth" }),
            );
          }}
        />
      ) : (
        detail.pausedReason &&
        detail.status === "paused" && (
          <p
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-400/40 dark:bg-amber-500/10"
            role="status"
          >
            Paused: {detail.pausedReason}
          </p>
        )
      )}
      {tab === "overview" && (
        <OverviewTab detail={detail} report={report} onOpenRuns={(runId) => go("runs", runId)} />
      )}
      {tab === "runs" && (
        <RunsTab automationId={detail.id} runId={run} onOpenRun={(runId) => go("runs", runId)} />
      )}
      {tab === "code" && <CodeTab detail={detail} />}
      {tab === "versions" && <VersionsTab detail={detail} isAdmin={isAdmin} />}
    </PageLayout>
  );
}

/** Pause (automation.disable) an active automation, Resume (automation.enable) a stopped one. */
function PauseButton({ detail }: { detail: AutomationDetailData }) {
  const { enable, disable } = useSetEnabled();
  const pending = enable.isPending || disable.isPending;
  if (detail.status === "removed") return null;
  const active = detail.status === "active" || detail.status === "killed";

  async function onClick() {
    try {
      if (active) {
        await disable.mutateAsync({ id: detail.id });
        toast.success(`Paused ${detail.label}`);
      } else {
        await enable.mutateAsync({ id: detail.id });
        toast.success(`Resumed ${detail.label}`);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void onClick()}
      disabled={pending}
      data-testid="pause-toggle"
    >
      {active ? <PauseIcon /> : <PlayIcon />}
      {active ? "Pause" : "Resume"}
    </Button>
  );
}

/**
 * Why it waits on connections ("Waiting for connections", "Connection revoked …"), with the way
 * out: bind them in the Permissions card, or resume once every connection is bound again.
 */
function ConnectionsBanner({
  banner,
  detail,
  onBind,
}: {
  banner: NonNullable<ReturnType<typeof connectionsBanner>>;
  detail: AutomationDetailData;
  onBind: () => void;
}) {
  const { enable } = useSetEnabled();
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-400/40 dark:bg-amber-500/10"
      role="status"
      data-testid="connections-banner"
    >
      <PlugIcon className="size-4 shrink-0 text-amber-800 dark:text-amber-300" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-medium">{banner.title}</span>
        <span className="text-muted-foreground">{banner.body}</span>
      </div>
      {banner.canResume ? (
        <Button
          size="sm"
          disabled={enable.isPending}
          onClick={() =>
            enable.mutateAsync({ id: detail.id }).then(
              () => toast.success(`Resumed ${detail.label}`),
              (error) => toast.error(errorMessage(error)),
            )
          }
        >
          <PlayIcon />
          Resume
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onBind}>
          <PlugIcon />
          Bind connections
        </Button>
      )}
    </div>
  );
}

/**
 * The in-app assistant arrives in stage 7. Until then the button is shown (as in the reference)
 * but disabled, saying where to ask instead: Claude through MCP.
 */
const ASK_REASON = "Coming in stage 7. Meanwhile, ask Claude about this automation through MCP.";

function AskAssistantButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled rather than disabled, so it stays focusable and the tooltip shows. */}
        <Button
          variant="outline"
          size="sm"
          aria-disabled="true"
          aria-description={ASK_REASON}
          className="cursor-not-allowed opacity-50"
          onClick={(event) => event.preventDefault()}
          data-testid="ask-assistant"
        >
          <MessageSquareIcon />
          Ask the assistant
        </Button>
      </TooltipTrigger>
      <TooltipContent>{ASK_REASON}</TooltipContent>
    </Tooltip>
  );
}
