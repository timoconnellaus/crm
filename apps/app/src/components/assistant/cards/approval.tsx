// The host-rendered approval card (ADR 0345, ADR 0346): a pending change in the chat, drawn with the
// pieces of the Approvals inbox (the readable diff, the outbound preview, the judge's note), with
// what the person asked and the agent's reason shown apart. High-risk items need the two-step
// button: "Send 240 emails", then "Confirm: send 240 emails", with Cancel.
//
// The step comes from the server, which refuses an approval without it; a typed or spoken approval
// goes through the chat (`approval.decide`), so only the tap is here.
import type { CoreOutput } from "@relationship-os/core";
import { combinedStep } from "@relationship-os/core/client";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { CheckIcon, XIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp } from "#/lib/query";
import { ChangePreview, RiskBadge } from "../../approvals/change-preview.tsx";
import { actionTitle, groupPreview, outboundTitle } from "../../approvals/describe.ts";
import { decide, useRecordNames, useRefreshAfterDecision } from "../../approvals/hooks.ts";
import { OutboundPreview } from "../../approvals/outbound-preview.tsx";
import { VerdictNote } from "../../approvals/verdict-note.tsx";
import { useCardHost } from "./host.tsx";
import { Body, Footer, Frame, Header, LinkButton, TwoStepButton } from "./parts.tsx";

type Action = CoreOutput<"approval.status">["changeSets"][number]["actions"][number];
type Decision = "approve" | "reject";

function titleOf(action: Action): string {
  return action.outbound
    ? outboundTitle(action.outbound)
    : actionTitle(action.operation, action.preview, action.input);
}

function ActionDetail({ action, names }: { action: Action; names: Map<string, string> }) {
  const groups = useMemo(() => groupPreview(action.preview), [action.preview]);
  return (
    <div className="grid min-w-0 gap-2" data-testid="assistant-pending-action">
      {action.outbound ? (
        <OutboundPreview outbound={action.outbound} />
      ) : (
        <ChangePreview groups={groups} names={names} />
      )}
      {action.adjudication && <VerdictNote verdict={action.adjudication} />}
    </div>
  );
}

export interface ApprovalViewProps {
  title: string;
  /** "pending", or how it ended. */
  state: string;
  /** What the person asked for, in their words. */
  youAsked?: string | undefined;
  /** The agent's reason, shown apart from what the person asked. */
  reason?: string | null | undefined;
  /** The risk badge. */
  risk?: string | undefined;
  /** The first and second press of a high-risk approval; absent for one tap. */
  step?: { label: string; confirmLabel: string } | null;
  canApprove: boolean;
  busy: boolean;
  reviewHref: string;
  onDecide(decision: Decision, confirm?: string): void;
  /** The diff. */
  children?: ReactNode;
}

/** The approval card itself, given what to show. */
export function ApprovalView({
  title,
  state,
  youAsked,
  reason,
  risk,
  step,
  canApprove,
  busy,
  reviewHref,
  onDecide,
  children,
}: ApprovalViewProps) {
  const pending = state === "pending";
  return (
    <Frame
      type="approval"
      tone={pending ? "pending" : state === "applied" ? "ok" : "default"}
      data-testid="assistant-pending"
      data-status={state}
    >
      <Header
        title={title}
        aside={<Badge variant="outline">{pending ? "Waiting for approval" : state}</Badge>}
      />
      <Body>
        {children}
        {(youAsked || reason) && (
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {youAsked && (
              <div className="contents">
                <dt className="text-muted-foreground">You asked</dt>
                <dd className="min-w-0 break-words italic">"{youAsked}"</dd>
              </div>
            )}
            {reason && (
              <div className="contents">
                <dt className="text-muted-foreground">Agent's reason</dt>
                <dd className="min-w-0 break-words">{reason}</dd>
              </div>
            )}
          </dl>
        )}
        {risk && pending && step && (
          <div>
            <RiskBadge risk={risk} />
          </div>
        )}
      </Body>
      {pending && (
        <Footer>
          {!canApprove ? (
            <span className="text-xs text-muted-foreground">
              Someone who can approve changes will review it.
            </span>
          ) : step ? (
            <TwoStepButton
              label={step.label}
              confirmLabel={step.confirmLabel}
              onConfirm={() => onDecide("approve", step.confirmLabel)}
              disabled={busy}
              testId="approval-two-step"
            />
          ) : (
            <Button
              size="xs"
              className="max-md:h-8"
              disabled={busy}
              onClick={() => onDecide("approve")}
            >
              <CheckIcon />
              Approve
            </Button>
          )}
          {canApprove && (
            <Button
              size="xs"
              variant="outline"
              className="max-md:h-8"
              disabled={busy}
              onClick={() => onDecide("reject")}
            >
              <XIcon />
              Reject
            </Button>
          )}
          <LinkButton href={reviewHref} label="Review" />
        </Footer>
      )}
    </Frame>
  );
}

export interface ApprovalCardProps {
  changeSetId: string;
  /** Only these actions of the set; absent: all of it. */
  actionIds?: readonly string[] | undefined;
  title?: string | undefined;
  youAsked?: string | undefined;
  /** The words of a proposed note (`activity.proposeNote`), which the diff does not read well. */
  note?: string | undefined;
}

/** A change set's pending actions, live from `approval.status`. */
export function ApprovalCard({ changeSetId, actionIds, title, youAsked, note }: ApprovalCardProps) {
  const { canApprove } = useCardHost();
  const only = actionIds?.length === 1 ? actionIds[0] : undefined;
  const status = useOp("approval.status", only ? { actionId: only } : { changeSetId });
  const refresh = useRefreshAfterDecision();
  const [busy, setBusy] = useState(false);
  const actions = useMemo(() => {
    const all = status.data?.changeSets.flatMap((s) => s.actions) ?? [];
    return actionIds?.length ? all.filter((a) => actionIds.includes(a.id)) : all;
  }, [status.data, actionIds]);
  const names = useRecordNames(useMemo(() => actions.flatMap((a) => a.preview), [actions]));

  if (status.isError) {
    return (
      <Frame type="approval" className="px-3 py-2.5 text-destructive" role="alert">
        {title ?? "This change"}: {errorMessage(status.error)}
      </Frame>
    );
  }
  if (!status.data)
    return <Skeleton className="h-28 rounded-[var(--radius)]" data-a2ui="approval" />;

  const pending = actions.filter((a) => a.status === "pending");
  const [first] = actions;

  async function run(decision: Decision, confirm?: string) {
    setBusy(true);
    try {
      const out = await decide(decision, { actionIds: pending.map((a) => a.id) }, confirm);
      const failed = out.results.find((r) => r.status === "failed");
      if (failed) toast.error(failed.statusReason ?? "It failed");
      else toast.success(decision === "approve" ? "Approved" : "Rejected");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return (
    <ApprovalView
      title={
        title ?? (actions.length === 1 && first ? titleOf(first) : `${actions.length} changes`)
      }
      state={pending.length ? "pending" : (first?.status ?? "pending")}
      youAsked={youAsked}
      reason={first?.reason}
      risk={first?.risk}
      step={combinedStep(pending.map((a) => a.secondStep))}
      canApprove={canApprove}
      busy={busy}
      reviewHref={`/approvals?set=${encodeURIComponent(changeSetId)}`}
      onDecide={(decision, confirm) => void run(decision, confirm)}
    >
      {note && <p className="min-w-0 break-words">{note}</p>}
      {actions.map((action) => (
        <ActionDetail key={action.id} action={action} names={names} />
      ))}
    </ApprovalView>
  );
}
