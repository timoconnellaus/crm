// Agents in the chat (ADR 0344): the live progress card, the grant to confirm before one starts, and
// one review of everything it staged. All host cards: only the app sends them, and each press calls
// an operation as the viewer. An agent can be stopped, not chatted with.
import type { RendererProps } from "@relationship-os/agent-a2ui/react";
import type { CoreOutput } from "@relationship-os/core";
import { combinedStep } from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { CheckIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, useOp } from "#/lib/query";
import { ChangePreview } from "../../approvals/change-preview.tsx";
import { actionTitle, groupPreview, outboundTitle } from "../../approvals/describe.ts";
import { decide, useRecordNames, useRefreshAfterDecision } from "../../approvals/hooks.ts";
import { useCardHost } from "./host.tsx";
import { Body, Facts, Footer, Frame, Header, LinkButton, Pill, TwoStepButton } from "./parts.tsx";

type Job = CoreOutput<"agent.status">["jobs"][number];
type Action = CoreOutput<"approval.get">["actions"][number];

const STATE_LABELS: Record<Job["state"], string> = {
  awaiting_confirm: "Needs your OK",
  refused: "Not started",
  queued: "Waiting",
  running: "Running",
  paused: "Paused",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
  cancelled: "Cancelled",
};

const LIVE: readonly Job["state"][] = ["queued", "running"];

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function minutes(from: string | null, to: string | null): number {
  if (!from) return 0;
  const end = to ? Date.parse(to) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(from)) / 60_000));
}

function changes(n: number): string {
  return `${n} change${n === 1 ? "" : "s"} to review`;
}

function useJob(jobId: string) {
  const status = useOp(
    "agent.status",
    { jobId },
    {
      // The thread's socket says when it moves; this covers a closed socket.
      refetchInterval: (query) => {
        const job = query.state.data?.jobs[0];
        return job && LIVE.includes(job.state) ? 10_000 : false;
      },
    },
  );
  return { status, job: status.data?.jobs[0] };
}

function JobDetails({ job }: { job: Job }) {
  return (
    <>
      <Facts
        items={[
          { label: "Steps", value: `${job.steps} of ${job.budget.steps}` },
          {
            label: "Time",
            value: `${minutes(job.startedAt, job.finishedAt)} of ${job.budget.minutes} min`,
          },
          { label: "Spend", value: `${money(job.spentUsd)} of ${money(job.budget.spendUsd)}` },
        ]}
      />
      <p className="min-w-0 break-words text-xs text-muted-foreground">{job.brief}</p>
      {LIVE.includes(job.state) && (
        <p className="text-xs text-muted-foreground">
          You can stop this agent but not message it. Ask me if you want it to do something
          differently.
        </p>
      )}
    </>
  );
}

/** The Allow $X more offer: what it has used, in steps of half a dollar or a quarter of the limit. */
function nextAllowance(job: Job): number {
  return Math.max(0.5, Math.round(job.budget.spendUsd * 25) / 100);
}

function headline(job: Job): string {
  const { progress } = job;
  if (job.state === "queued")
    return `Waiting for a free slot${job.placeLabel ? `, ${job.placeLabel}` : ""}.`;
  if (job.state === "paused") {
    return `It used its whole spend limit: ${money(job.spentUsd)} of ${money(job.budget.spendUsd)}.`;
  }
  if (job.state === "failed") return job.error ?? "It failed.";
  if (job.state === "stopped") return job.error ?? "Nothing else will run. What it did is kept.";
  if (progress?.total) return `${progress.done ?? 0} of ${progress.total} done`;
  return job.state === "running" ? "Starting" : "";
}

export function AgentJobComponent({ props }: RendererProps<"agentJob">) {
  const { status, job } = useJob(props.jobId);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const refresh = useRefreshAfterDecision();
  if (status.isError) {
    return (
      <Frame type="agentJob" className="px-3 py-2.5 text-muted-foreground">
        {props.title}: {errorMessage(status.error)}
      </Frame>
    );
  }
  if (!job) return <Skeleton className="h-20 rounded-[var(--radius)]" data-a2ui="agentJob" />;

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const live = LIVE.includes(job.state);
  const allowance = nextAllowance(job);
  return (
    <Frame
      type="agentJob"
      tone={job.state === "paused" ? "pending" : job.state === "done" ? "ok" : "default"}
      data-testid="agent-job"
      data-state={job.state}
    >
      <Header title={job.title} aside={<Pill tone="neutral">{STATE_LABELS[job.state]}</Pill>} />
      <Body>
        <p className="min-w-0 break-words" data-testid="agent-job-progress">
          {headline(job)}
        </p>
        {job.state === "running" && job.progress?.now && (
          <p className="truncate text-xs text-muted-foreground">Now: {job.progress.now}</p>
        )}
        {job.fieldsFilled > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="agent-job-filled">
            {job.fieldsFilled} field{job.fieldsFilled === 1 ? "" : "s"} filled
          </p>
        )}
        {job.toReview > 0 && (
          <p className="font-medium" data-testid="agent-job-review">
            {changes(job.toReview)}
          </p>
        )}
        {details && <JobDetails job={job} />}
      </Body>
      <Footer>
        {job.state === "paused" && (
          <Button
            size="xs"
            className="max-md:h-8"
            disabled={busy}
            onClick={() =>
              void act(() => callOp("agent.allowSpend", { jobId: job.id, usd: allowance }))
            }
          >
            Allow {money(allowance)} more
          </Button>
        )}
        {(live || job.state === "paused") && (
          <Button
            size="xs"
            variant="outline"
            className="max-md:h-8"
            disabled={busy}
            onClick={() => void act(() => callOp("agent.stop", { jobId: job.id }))}
          >
            {job.state === "queued" ? "Cancel" : job.state === "paused" ? "Stop here" : "Stop"}
          </Button>
        )}
        {job.toReview > 0 && job.changeSetId && (
          <LinkButton
            href={`/approvals?set=${encodeURIComponent(job.changeSetId)}`}
            label="Review"
          />
        )}
        <Button
          size="xs"
          variant="ghost"
          className="max-md:h-8"
          aria-expanded={details}
          onClick={() => setDetails((open) => !open)}
        >
          Details
        </Button>
      </Footer>
    </Frame>
  );
}

export function AgentGrantComponent({ props }: RendererProps<"agentGrant">) {
  const { job } = useJob(props.jobId);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshAfterDecision();
  // Once answered, the card follows the agent.
  if (job && job.state !== "awaiting_confirm") {
    return <AgentJobComponent {...({ props } as unknown as RendererProps<"agentJob">)} />;
  }

  async function answer(decision: "start" | "startReviewing" | "cancel") {
    setBusy(true);
    try {
      await callOp("agent.confirmGrant", { jobId: props.jobId, decision });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return (
    <Frame type="agentGrant" tone="pending" data-testid="agent-grant">
      <Header title={`Before I start: ${props.title}`} />
      <Body>
        <p className="min-w-0 break-words">{props.brief}</p>
        <div>
          <p className="text-xs font-medium">It can do this without asking</p>
          <ul className="grid gap-0.5 text-[13px]">
            {props.can.map((line) => (
              <li key={line} className="min-w-0 break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs font-medium">It will put these aside for you</p>
          <ul className="grid gap-0.5 text-[13px]">
            {props.aside.map((line) => (
              <li key={line} className="min-w-0 break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">{props.budget}</p>
        {props.note && <p className="text-xs text-muted-foreground">{props.note}</p>}
      </Body>
      <Footer>
        <Button
          size="xs"
          className="max-md:h-8"
          disabled={busy}
          onClick={() => void answer("start")}
        >
          Start
        </Button>
        <Button
          size="xs"
          variant="outline"
          className="max-md:h-8"
          disabled={busy}
          onClick={() => void answer("startReviewing")}
        >
          Start, but ask me for every change
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="max-md:h-8"
          disabled={busy}
          onClick={() => void answer("cancel")}
        >
          Cancel
        </Button>
      </Footer>
    </Frame>
  );
}

function titleOf(action: Action): string {
  return action.outbound
    ? outboundTitle(action.outbound)
    : actionTitle(action.operation, action.preview, action.input);
}

function ReviewRow({
  action,
  names,
  busy,
  onDecide,
}: {
  action: Action;
  names: Map<string, string>;
  busy: boolean;
  onDecide(decision: "approve" | "reject", confirm?: string): void;
}) {
  const groups = useMemo(() => groupPreview(action.preview), [action.preview]);
  const step = action.secondStep;
  return (
    <li className="grid min-w-0 gap-1.5 px-3 py-2" data-testid="change-review-row">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <ChangePreview groups={groups} names={names} />
          <p className="min-w-0 break-words text-xs text-muted-foreground">
            Agent's reason: {action.reason}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {step ? (
            <TwoStepButton
              label={step.label}
              confirmLabel={step.confirmLabel}
              onConfirm={() => onDecide("approve", step.confirmLabel)}
              disabled={busy}
            />
          ) : (
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={`Approve: ${titleOf(action)}`}
              disabled={busy}
              onClick={() => onDecide("approve")}
            >
              <CheckIcon />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Reject: ${titleOf(action)}`}
            disabled={busy}
            onClick={() => onDecide("reject")}
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Everything one agent staged, as one diff: each row on its own, or all of them. */
export function ChangeReviewComponent({ props }: RendererProps<"changeReview">) {
  const { canApprove } = useCardHost();
  const detail = useOp("approval.get", { changeSetId: props.changeSetId });
  const refresh = useRefreshAfterDecision();
  const [busy, setBusy] = useState(false);
  const actions = detail.data?.actions;
  const pending = useMemo(() => (actions ?? []).filter((a) => a.status === "pending"), [actions]);
  const names = useRecordNames(useMemo(() => pending.flatMap((a) => a.preview), [pending]));
  if (detail.isError) {
    return (
      <Frame type="changeReview" className="px-3 py-2.5 text-muted-foreground">
        {props.title}: {errorMessage(detail.error)}
      </Frame>
    );
  }
  if (!detail.data) {
    return <Skeleton className="h-28 rounded-[var(--radius)]" data-a2ui="changeReview" />;
  }

  async function run(
    decision: "approve" | "reject",
    target: { changeSetId: string } | { actionIds: string[] },
    confirm?: string,
  ) {
    setBusy(true);
    try {
      const out = await decide(decision, target, confirm);
      const failed = out.results.find((r) => r.status === "failed");
      if (failed) toast.error(failed.statusReason ?? "It failed");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const all = { changeSetId: props.changeSetId };
  const step = combinedStep(pending.map((a) => a.secondStep));
  const left = pending.length;
  return (
    <Frame
      type="changeReview"
      tone={left ? "pending" : "ok"}
      data-testid="change-review"
      data-left={left}
    >
      <Header
        title={left ? changes(left) : "Reviewed"}
        subtitle={props.title}
        aside={left ? <Pill tone="neutral">{left} left</Pill> : undefined}
      />
      {left > 0 && props.text && (
        <Body>
          <p className="min-w-0 break-words">{props.text}</p>
        </Body>
      )}
      {left > 0 && (
        <ul className="divide-y border-t" aria-label="Changes">
          {pending.map((action) => (
            <ReviewRow
              key={action.id}
              action={action}
              names={names}
              busy={busy || !canApprove}
              onDecide={(decision, confirm) =>
                void run(decision, { actionIds: [action.id] }, confirm)
              }
            />
          ))}
        </ul>
      )}
      {left > 0 && canApprove && (
        <Footer>
          {step ? (
            <TwoStepButton
              label={step.label}
              confirmLabel={step.confirmLabel}
              onConfirm={() => void run("approve", all, step.confirmLabel)}
              disabled={busy}
              testId="change-review-two-step"
            />
          ) : (
            <Button
              size="xs"
              className="max-md:h-8"
              disabled={busy}
              onClick={() => void run("approve", all)}
            >
              <CheckIcon />
              Approve all ({left})
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            className="max-md:h-8"
            disabled={busy}
            onClick={() => void run("reject", all)}
          >
            <XIcon />
            Reject all
          </Button>
        </Footer>
      )}
    </Frame>
  );
}
