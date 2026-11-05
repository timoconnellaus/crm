// Automations on record pages and lists:
// - ManualAutomationButtons: one header button per enabled manual automation of the object
//   (automation.list { manualFor }) that runs it on this record (automation.run).
// - AutomationBulkActions: the same for selected rows of a list, for `bulk` manual automations,
//   100 records per call.
// - RecordAutomationsCard: the per-record Automations section, runs that touched the record
//   (automation.runs { record }), each linking to the run.
// All stay out of the way when the automation operations fail (nothing to show).
import { Button } from "@relationship-os/ui/components/button";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ZapIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LoadMoreSentinel } from "#/components/layout/infinite";
import { callStageOp } from "#/lib/automation-ops";
import { errorMessage, invalidateAfterWrite } from "#/lib/query";
import { type AutomationItem, useManualAutomations, useRuns } from "./hooks.ts";
import { compactRelative } from "./model.ts";
import { RunOutcome } from "./parts.tsx";

/** Runs `automation` on `ids` (≤100 per call); returns started and skipped counts. */
async function runOn(automation: AutomationItem, object: string, ids: readonly string[]) {
  let started: string[] = [];
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const result = await callStageOp("automation.run", {
      id: automation.id,
      object,
      recordIds: ids.slice(i, i + 100),
    });
    started = [...started, ...result.runIds];
    skipped += result.skipped;
  }
  return { started, skipped };
}

function useRunAutomation(object: string) {
  const client = useQueryClient();
  const router = useRouter();
  const [running, setRunning] = useState<string | null>(null);
  async function run(automation: AutomationItem, ids: readonly string[], onDone?: () => void) {
    setRunning(automation.id);
    try {
      const { started, skipped } = await runOn(automation, object, ids);
      const firstRun = started[0];
      const label = automation.manual?.label ?? automation.label;
      const text =
        started.length === 1
          ? `Started “${label}”`
          : `Started “${label}” on ${started.length} records`;
      toast.success(skipped ? `${text} (${skipped} skipped by safety rails)` : text, {
        ...(firstRun && started.length === 1
          ? {
              action: {
                label: "View run",
                onClick: () =>
                  void router.navigate({
                    to: "/automations/$id",
                    params: { id: automation.id },
                    search: { tab: "runs", run: firstRun },
                  }),
              },
            }
          : {}),
      });
      onDone?.();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRunning(null);
      await invalidateAfterWrite(client, "automation.run", ["task.", "record.", "notification."]);
    }
  }
  return { run, running };
}

export function ManualAutomationButtons({ object, id }: { object: string; id: string }) {
  const automations = useManualAutomations(object, "record");
  const { run, running } = useRunAutomation(object);
  if (!automations.length) return null;
  return (
    <>
      {automations.map((automation) => (
        <Button
          key={automation.id}
          variant="outline"
          size="sm"
          disabled={running !== null}
          onClick={() => void run(automation, [id])}
          data-testid={`manual-automation-${automation.id}`}
          title={automation.description || automation.label}
        >
          <ZapIcon />
          {running === automation.id ? "Starting…" : (automation.manual?.label ?? automation.label)}
        </Button>
      ))}
    </>
  );
}

export function AutomationBulkActions({
  object,
  ids,
  onDone,
}: {
  object: string;
  ids: readonly string[];
  onDone: () => void;
}) {
  const automations = useManualAutomations(object, "bulk");
  const { run, running } = useRunAutomation(object);
  return (
    <>
      {automations.map((automation) => (
        <Button
          key={automation.id}
          variant="outline"
          size="sm"
          disabled={running !== null || !ids.length}
          onClick={() => void run(automation, ids, onDone)}
          data-testid={`bulk-automation-${automation.id}`}
        >
          <ZapIcon />
          {running === automation.id ? "Starting…" : (automation.manual?.label ?? automation.label)}
        </Button>
      ))}
    </>
  );
}

/** The record page's Automations section: runs that touched this record. */
export function RecordAutomationsCard({ object, id }: { object: string; id: string }) {
  const { query, items } = useRuns({ record: { object, id }, limit: 10 });
  if (query.isError && !items.length) return null;
  return (
    <section
      className="grid gap-2 rounded-lg border p-4"
      data-testid="record-automations"
      aria-labelledby="record-automations-title"
    >
      <h2 id="record-automations-title" className="text-sm font-medium">
        Automations
      </h2>
      {query.isPending ? (
        <Skeleton className="h-12" />
      ) : !items.length ? (
        <p className="text-sm text-muted-foreground">No automation has run on this record.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Automation runs">
          {items.map((run) => (
            <li key={run.id} className="grid gap-0.5 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  to="/automations/$id"
                  params={{ id: run.automationId }}
                  search={{ tab: "runs", run: run.id }}
                  className="min-w-0 truncate font-medium hover:underline"
                >
                  {run.automationLabel}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {compactRelative(run.startedAt)}
                </span>
              </div>
              <RunOutcome run={run} className="text-xs" />
            </li>
          ))}
        </ul>
      )}
      <LoadMoreSentinel source={query} label="automation runs" />
    </section>
  );
}
