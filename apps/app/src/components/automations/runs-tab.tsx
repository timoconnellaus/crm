// The automation page's Runs tab: every run (automation.runs), virtualised with infinite scroll,
// and a run's detail: trigger and record, steps with timings, operations and logs, its waiting,
// review or failed state, the change set it is waiting on, and Retry / Replay / Cancel.
import type { RunOperationRecord, RunStepRecord } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, PlayIcon, RotateCcwIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { HrefLink } from "#/components/href-link";
import { VirtualFeed } from "#/components/layout/infinite";
import { useStageMutation } from "#/lib/automation-ops";
import { formatDateTime } from "#/lib/format";
import { errorMessage } from "#/lib/query";
import { recordHref } from "#/lib/schema";
import { type RunData, useRun, useRuns } from "./hooks.ts";
import { compactRelative, formatMs, RUN_STATUS_LABELS } from "./model.ts";
import { RunOutcome } from "./parts.tsx";

const ALL = "all";
const STATUSES = Object.keys(RUN_STATUS_LABELS) as (keyof typeof RUN_STATUS_LABELS)[];

export function RunsTab({
  automationId,
  runId,
  onOpenRun,
}: {
  automationId: string;
  runId: string | undefined;
  onOpenRun: (runId: string | undefined) => void;
}) {
  if (runId)
    return <RunDetail runId={runId} onBack={() => onOpenRun(undefined)} onOpenRun={onOpenRun} />;
  return <RunsList automationId={automationId} onOpenRun={onOpenRun} />;
}

function RunsList({
  automationId,
  onOpenRun,
}: {
  automationId: string;
  onOpenRun: (runId: string) => void;
}) {
  const [status, setStatus] = useState<string>(ALL);
  const [tests, setTests] = useState(false);
  const { query, items } = useRuns({
    id: automationId,
    limit: 50,
    includeTests: tests,
    ...(status === ALL ? {} : { status: status as RunData["status"] }),
  });
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-48" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every status</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {RUN_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={tests ? "secondary" : "outline"}
          size="sm"
          aria-pressed={tests}
          onClick={() => setTests(!tests)}
        >
          Include test runs
        </Button>
      </div>
      {query.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : query.isError && !items.length ? (
        <ErrorState
          title="Could not load runs"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : !items.length ? (
        <EmptyState
          icon={WorkflowIcon}
          title="No runs yet"
          description="Runs appear here when the trigger fires."
        />
      ) : (
        <VirtualFeed
          as="ul"
          label="Runs"
          items={items}
          getKey={(run) => run.id}
          estimateSize={60}
          source={query}
          className="rounded-md border"
          itemClassName="border-b last:border-b-0"
          itemTestId="run-item"
          renderItem={(run) => <RunRow run={run} onOpen={() => onOpenRun(run.id)} />}
        />
      )}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: RunData; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
    >
      <span className="min-w-0 flex-1 truncate font-medium">
        {run.record?.title ?? run.record?.id ?? "Scheduled run"}
      </span>
      {run.test && <Badge variant="outline">Test</Badge>}
      {run.depth > 0 && <Badge variant="secondary">Cascade {run.depth}</Badge>}
      <RunOutcome run={run} />
      <span className="w-20 text-right text-muted-foreground" title={formatDateTime(run.startedAt)}>
        {compactRelative(run.startedAt)}
      </span>
    </button>
  );
}

function stepsOf(run: RunData): RunStepRecord[] {
  return run.steps.filter(
    (s): s is RunStepRecord => Boolean(s) && typeof s === "object" && "name" in (s as object),
  );
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return JSON.stringify(error);
}

function triggerText(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== "object") return null;
  const t = trigger as Record<string, unknown>;
  const type = typeof t.type === "string" ? t.type : null;
  const action = typeof t.action === "string" ? t.action : null;
  return [type, action].filter(Boolean).join(" · ") || null;
}

export function RunDetail({
  runId,
  onBack,
  onOpenRun,
}: {
  runId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const query = useRun(runId);
  const retry = useStageMutation("automation.retry", { invalidates: ["automation."] });
  const replay = useStageMutation("automation.replay", { invalidates: ["automation."] });
  const cancel = useStageMutation("automation.cancel", { invalidates: ["automation."] });
  const run = query.data?.items[0];

  async function act(kind: "retry" | "replay" | "cancel") {
    try {
      const mutation = kind === "retry" ? retry : kind === "replay" ? replay : cancel;
      const result = await mutation.mutateAsync({ runId });
      toast.success(
        kind === "retry"
          ? "Retrying the run"
          : kind === "replay"
            ? "Replaying against current data"
            : "Run cancelled",
      );
      if (result.runId !== runId) onOpenRun(result.runId);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const back = (
    <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
      <ChevronLeftIcon />
      All runs
    </Button>
  );
  if (query.isPending) {
    return (
      <div className="grid gap-3">
        {back}
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (query.error || !run) {
    return (
      <div className="grid gap-3">
        {back}
        <ErrorState
          title="Could not load the run"
          error={query.error ?? new Error("Run not found")}
        />
      </div>
    );
  }
  const steps = stepsOf(run);
  const live = ["queued", "running", "waiting", "review"].includes(run.status);
  const busy = retry.isPending || replay.isPending || cancel.isPending;
  const failure = errorText(run.error);
  const trigger = triggerText(run.trigger);

  return (
    <div className="grid gap-3" data-testid="run-detail">
      {back}
      <section className="grid gap-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
            {run.record ? (
              <HrefLink
                href={recordHref(run.record.object, run.record.id)}
                className="hover:underline"
              >
                {run.record.title ?? run.record.id}
              </HrefLink>
            ) : (
              "Scheduled run"
            )}
          </h2>
          {run.test && <Badge variant="outline">Test</Badge>}
          <RunOutcome run={run} className="text-sm font-medium" />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            {RUN_STATUS_LABELS[run.status]}
            {run.statusReason ? ` · ${run.statusReason}` : ""}
          </dd>
          {trigger && (
            <>
              <dt className="text-muted-foreground">Trigger</dt>
              <dd>{trigger}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
          {run.finishedAt && (
            <>
              <dt className="text-muted-foreground">Finished</dt>
              <dd>{formatDateTime(run.finishedAt)}</dd>
            </>
          )}
          {run.waitUntil && (
            <>
              <dt className="text-muted-foreground">Resumes</dt>
              <dd>{formatDateTime(run.waitUntil)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Writes</dt>
          <dd>{run.writes}</dd>
          {run.depth > 0 && (
            <>
              <dt className="text-muted-foreground">Cascade depth</dt>
              <dd>{run.depth}</dd>
            </>
          )}
          {(run.retryOf || run.replayOf) && (
            <>
              <dt className="text-muted-foreground">{run.retryOf ? "Retry of" : "Replay of"}</dt>
              <dd>
                <button
                  type="button"
                  className="font-mono text-xs underline"
                  onClick={() => onOpenRun((run.retryOf ?? run.replayOf) as string)}
                >
                  {run.retryOf ?? run.replayOf}
                </button>
              </dd>
            </>
          )}
        </dl>
        {run.changeSetId && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-400/40 dark:bg-amber-500/10"
            data-testid="run-change-set"
          >
            <span className="flex-1">
              {run.status === "review"
                ? "Paused until someone reviews its changes."
                : "Its changes went to review."}
            </span>
            <Button asChild size="sm" variant="outline">
              <Link to="/approvals" search={{ set: run.changeSetId }}>
                Open change set
              </Link>
            </Button>
          </div>
        )}
        {failure && (
          <p
            className="rounded-md bg-destructive/5 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {run.status === "failed" && (
            <Button size="sm" onClick={() => void act("retry")} disabled={busy}>
              <RotateCcwIcon />
              Retry
            </Button>
          )}
          {!run.test && (
            <Button size="sm" variant="outline" onClick={() => void act("replay")} disabled={busy}>
              <PlayIcon />
              Replay
            </Button>
          )}
          {live && (
            <Button size="sm" variant="outline" onClick={() => void act("cancel")} disabled={busy}>
              <SquareIcon />
              Cancel run
            </Button>
          )}
        </div>
      </section>
      <section className="grid gap-2" aria-label="Steps">
        <h3 className="text-sm font-medium">Steps</h3>
        {!steps.length ? (
          <p className="text-sm text-muted-foreground">No steps have run yet.</p>
        ) : (
          <ol className="grid gap-2">
            {steps.map((step, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered journal
              <StepItem key={i} index={i} step={step} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const STEP_TONE: Record<RunStepRecord["status"], string> = {
  running: "text-amber-800 dark:text-amber-300",
  waiting: "text-amber-800 dark:text-amber-300",
  review: "text-amber-800 dark:text-amber-300",
  completed: "text-green-700 dark:text-green-400",
  failed: "text-red-700 dark:text-red-400",
  skipped: "text-muted-foreground",
};

function StepItem({ index, step }: { index: number; step: RunStepRecord }) {
  return (
    <li
      className={cn(
        "grid gap-2 rounded-lg border p-3 text-sm",
        step.kind !== "do" && "border-dashed",
      )}
      data-testid="run-step"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
          Step {index + 1} ·{" "}
          {step.kind === "do" ? "do" : step.kind === "sleep" ? "wait" : "wait for event"}
        </span>
        <span className="min-w-0 flex-1 font-medium break-words">{step.name}</span>
        <span className={STEP_TONE[step.status]}>{step.status}</span>
        {step.ms !== undefined && (
          <span className="text-muted-foreground">{formatMs(step.ms)}</span>
        )}
        {(step.attempts ?? 1) > 1 && <Badge variant="secondary">{step.attempts} attempts</Badge>}
      </div>
      {step.until && (
        <p className="text-muted-foreground">
          {step.status === "waiting" ? "Resumes" : "Waited until"} {formatDateTime(step.until)}
        </p>
      )}
      {step.error && (
        <p className="text-destructive">
          {step.error.code}: {step.error.message}
        </p>
      )}
      {step.operations.length > 0 && (
        <ul className="grid gap-1" aria-label="Operations">
          {step.operations.map((op, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an ordered call log
            <OperationLine key={i} op={op} />
          ))}
        </ul>
      )}
      {step.logs.length > 0 && (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {step.logs.map((log) => `[${log.level}] ${log.message}`).join("\n")}
        </pre>
      )}
    </li>
  );
}

function OperationLine({ op }: { op: RunOperationRecord }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <code className="rounded bg-muted px-1 font-mono text-xs">{op.operation}</code>
      <span
        className={op.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}
      >
        {op.ok ? "ok" : (op.code ?? "failed")}
      </span>
      {op.gate && <Badge variant="outline">gate: {op.gate}</Badge>}
      {op.undeclared && <Badge variant="secondary">undeclared</Badge>}
      {op.records?.map((r) => (
        <HrefLink
          key={`${r.object}:${r.id}`}
          href={recordHref(r.object, r.id)}
          className="text-xs underline"
        >
          {r.action} {r.object}
        </HrefLink>
      ))}
      <span className="text-xs text-muted-foreground">{formatMs(op.ms)}</span>
    </li>
  );
}
