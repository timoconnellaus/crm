// One change set in the Approvals inbox (stage 2 mockup): a header with the client app, title,
// owner, counts and age/expiry plus approve/reject buttons, then its pending actions with
// checkboxes, each showing the operation, risk, the agent's reason and a readable diff. Deciding
// shows what happened: dependent actions rejected with it, failures and skips with reasons.
import type { CoreOutput } from "@crm/core";
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, formatRelative } from "#/lib/format";
import { errorMessage, useOp } from "#/lib/query";
import { ChangeSetExplanation } from "../ai/summary.tsx";
import { ChangePreview, RiskBadge, StatusBadge } from "./change-preview.tsx";
import { actionTitle, groupPreview, outboundTitle, summariseDecision } from "./describe.ts";
import { ExtensionProposal } from "./extension-proposal.tsx";
import { decide, useRecordNames, useRefreshAfterDecision } from "./hooks.ts";
import { OutboundPreview } from "./outbound-preview.tsx";

type ChangeSet = CoreOutput<"approval.get">;
type ChangeSetSummary = Omit<ChangeSet, "actions">;
type Action = ChangeSet["actions"][number];
type Decision = "approve" | "reject";

interface Outcome {
  decision: Decision;
  headline: string;
  problems: { actionId: string; status: string; statusReason: string | null }[];
}

export interface ChangeSetCardProps {
  changeSetId: string;
  /** The set as approval.list returned it: the header shows before the actions load. */
  summary?: ChangeSetSummary;
  /** History: start collapsed with a toggle; actions load when opened. */
  collapsible?: boolean;
  /** Scroll to and outline this set (opened from a record's pending badge). */
  highlighted?: boolean;
  isAdmin: boolean;
}

export function ChangeSetCard({
  changeSetId,
  summary,
  collapsible = false,
  highlighted = false,
  isAdmin,
}: ChangeSetCardProps) {
  const [open, setOpen] = useState(!collapsible || highlighted);
  const detail = useOp(
    "approval.get",
    { changeSetId },
    { staleTime: 0, enabled: open || !summary },
  );
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlighted && detail.isSuccess) ref.current?.scrollIntoView({ block: "start" });
  }, [highlighted, detail.isSuccess]);

  const set = detail.data ?? summary;
  if (!set) {
    if (detail.isError) {
      return (
        <div className="rounded-xl border p-4 text-sm text-destructive" role="alert">
          Could not load change set {changeSetId}: {errorMessage(detail.error)}
        </div>
      );
    }
    return <Skeleton className="h-32 rounded-xl" />;
  }
  return (
    <ChangeSetView
      ref={ref}
      set={set}
      actions={detail.data?.actions}
      open={open}
      onToggle={collapsible ? () => setOpen((v) => !v) : null}
      highlighted={highlighted}
      isAdmin={isAdmin}
    />
  );
}

function setHeading(set: ChangeSetSummary): string {
  return set.clientName ?? (set.actor === "mcp" ? "MCP client" : set.actor);
}

function countsLine(set: ChangeSetSummary): string {
  const c = set.counts;
  const parts = [`${c.total} change${c.total === 1 ? "" : "s"}`];
  if (c.pending) parts.push(`${c.pending} need${c.pending === 1 ? "s" : ""} review`);
  if (c.applied) parts.push(`${c.applied} applied`);
  if (c.rejected) parts.push(`${c.rejected} rejected`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.expired) parts.push(`${c.expired} expired`);
  return parts.join(" · ");
}

const NO_ACTIONS: Action[] = [];

function ChangeSetView({
  ref,
  set,
  actions = NO_ACTIONS,
  open,
  onToggle,
  highlighted,
  isAdmin,
}: {
  ref: Ref<HTMLElement>;
  set: ChangeSetSummary;
  /** Undefined while loading. */
  actions?: Action[];
  open: boolean;
  /** Collapsible sets get a toggle. */
  onToggle: (() => void) | null;
  highlighted: boolean;
  isAdmin: boolean;
}) {
  const refresh = useRefreshAfterDecision();
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = actions.filter((a) => a.status === "pending");
  const selected = pending.filter((a) => !deselected.has(a.id));
  const all = selected.length === pending.length;
  const allEntries = useMemo(() => actions.flatMap((a) => a.preview), [actions]);
  const names = useRecordNames(allEntries);
  const titles = useMemo(
    () =>
      new Map(
        actions.map((a) => [
          a.id,
          a.outbound ? outboundTitle(a.outbound) : actionTitle(a.operation, a.preview, a.input),
        ]),
      ),
    [actions],
  );

  async function run(decision: Decision) {
    if (!selected.length) return;
    setBusy(decision);
    setError(null);
    const requested = all ? null : selected.map((a) => a.id);
    try {
      const out = await decide(
        decision,
        requested ? { actionIds: requested } : { changeSetId: set.id },
      );
      const summary = summariseDecision(
        decision,
        out.results,
        requested ?? pending.map((a) => a.id),
      );
      setOutcome({ decision, headline: summary.headline, problems: summary.problems });
      setDeselected(new Set());
      if (summary.problems.length) toast.warning(summary.headline);
      else toast.success(summary.headline);
    } catch (e) {
      setError(errorMessage(e));
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const n = selected.length;
  const approveLabel = n > 1 ? `Approve ${n}` : "Approve";
  const rejectLabel = all ? (n > 1 ? "Reject all" : "Reject") : `Reject ${n}`;
  const heading = setHeading(set);

  return (
    <section
      ref={ref}
      className={cn(
        "scroll-mt-20 overflow-hidden rounded-xl border",
        highlighted && "ring-2 ring-ring",
      )}
      aria-label={`Change set from ${heading}${set.title ? `: ${set.title}` : ""}`}
      data-testid="change-set"
      data-change-set={set.id}
      data-status={set.status}
    >
      <header className="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-3.5 py-3 sm:flex-nowrap">
        {onToggle && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={open ? "Hide changes" : "Show changes"}
            aria-expanded={open}
            onClick={onToggle}
          >
            <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
          </Button>
        )}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="text-sm">
            <span className="font-semibold">{heading}</span>
            {set.title && <span> · “{set.title}”</span>}
          </div>
          <div className="text-xs text-muted-foreground">
            {set.userName ? `${set.userName}'s connection · ` : ""}
            {countsLine(set)} ·{" "}
            <time dateTime={set.createdAt} title={formatDateTime(set.createdAt)}>
              {formatRelative(set.createdAt)}
            </time>
            {set.expiresAt && set.status === "awaiting_review" && (
              <>
                {" "}
                · expires{" "}
                <time dateTime={set.expiresAt} title={formatDateTime(set.expiresAt)}>
                  {formatRelative(set.expiresAt)}
                </time>
              </>
            )}
          </div>
        </div>
        {pending.length > 0 && (
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 sm:flex-none"
              disabled={!n || busy !== null}
              onClick={() => void run("reject")}
            >
              <XIcon />
              {busy === "reject" ? "Rejecting…" : rejectLabel}
            </Button>
            <Button
              size="sm"
              className="flex-1 sm:flex-none"
              disabled={!n || busy !== null}
              onClick={() => void run("approve")}
            >
              <CheckIcon />
              {busy === "approve" ? "Applying…" : approveLabel}
            </Button>
          </div>
        )}
      </header>
      {error && (
        <div
          className="flex items-start gap-2 border-b bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive"
          role="alert"
          data-testid="decision-error"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {outcome && (
        <div
          className={cn(
            "grid gap-1 border-b px-3.5 py-2.5 text-sm",
            outcome.problems.length ? "bg-amber-50 dark:bg-amber-500/10" : "bg-muted/30",
          )}
          role="status"
          data-testid="decision-result"
        >
          <p className="font-medium">{outcome.headline}</p>
          {outcome.problems.length > 0 && (
            <ul className="grid gap-0.5 text-xs">
              {outcome.problems.map((p) => (
                <li key={p.actionId}>
                  <span className="font-medium">{titles.get(p.actionId) ?? p.actionId}</span>{" "}
                  {p.status}: {p.statusReason?.replace(/^(Failed|Skipped): /, "")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {open && set.counts.total > 0 && <ChangeSetExplanation changeSetId={set.id} />}
      {open && actions === NO_ACTIONS && set.counts.total > 0 && (
        <div className="p-3.5">
          <Skeleton className="h-16" />
        </div>
      )}
      {open && (
        <ul aria-label="Changes" className="divide-y">
          {actions.map((action) => (
            <ActionItem
              key={action.id}
              action={action}
              title={titles.get(action.id) ?? action.operation}
              titles={titles}
              names={names}
              selected={!deselected.has(action.id)}
              onSelect={(checked) =>
                setDeselected((current) => {
                  const next = new Set(current);
                  if (checked) next.delete(action.id);
                  else next.add(action.id);
                  return next;
                })
              }
              isAdmin={isAdmin}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionItem({
  action,
  title,
  titles,
  names,
  selected,
  onSelect,
  isAdmin,
}: {
  action: Action;
  title: string;
  titles: Map<string, string>;
  names: Map<string, string>;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  isAdmin: boolean;
}) {
  const [details, setDetails] = useState(false);
  const groups = useMemo(() => groupPreview(action.preview), [action.preview]);
  const pending = action.status === "pending";
  const checkboxId = `select-${action.id}`;
  return (
    <li
      className="flex items-start gap-3 px-3.5 py-3"
      data-testid="pending-action"
      data-action={action.id}
      data-status={action.status}
    >
      <div className="flex h-5 w-4 shrink-0 items-center">
        {pending && (
          <Checkbox
            id={checkboxId}
            checked={selected}
            onCheckedChange={(checked) => onSelect(checked === true)}
            aria-label={`Select: ${title}`}
          />
        )}
      </div>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <label htmlFor={pending ? checkboxId : undefined} className="font-semibold">
            {title}
          </label>
          <RiskBadge risk={action.risk} />
          {!pending && <StatusBadge status={action.status} />}
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="sr-only">The agent's </span>Reason: {action.reason}
        </p>
        {action.outbound ? (
          <OutboundPreview outbound={action.outbound} />
        ) : action.operation === "extension.apply" ? (
          <ExtensionProposal actionId={action.id} status={action.status} />
        ) : (
          <ChangePreview groups={groups} names={names} />
        )}
        {!pending && action.statusReason && (
          <p
            className={cn(
              "text-xs",
              action.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
            data-testid="status-reason"
          >
            {action.statusReason}
          </p>
        )}
        {pending && action.dependsOn.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Depends on{" "}
            {action.dependsOn.map((id) => titles.get(id) ?? "an earlier change").join(", ")}:
            approve it first or together; rejecting it rejects this too.
          </p>
        )}
        {details && (
          <dl className="grid gap-x-3 gap-y-1 rounded-md border p-2.5 text-xs sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Operation</dt>
            <dd>
              <code className="font-mono">{action.operation}</code>
            </dd>
            <dt className="text-muted-foreground">Queued</dt>
            <dd>{formatDateTime(action.createdAt)}</dd>
            {pending && (
              <>
                <dt className="text-muted-foreground">Expires</dt>
                <dd>{formatDateTime(action.expiresAt)}</dd>
              </>
            )}
            {action.bindings && Object.keys(action.bindings).length > 0 && (
              <>
                <dt className="text-muted-foreground">Created</dt>
                <dd className="grid gap-0.5">
                  {Object.entries(action.bindings).map(([provisional, real]) => (
                    <span key={provisional} className="break-all font-mono">
                      {provisional} → {real}
                    </span>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Input</dt>
            <dd className="min-w-0">
              <pre className="max-h-48 overflow-auto rounded bg-muted/60 p-2 font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(action.input, null, 2)}
              </pre>
            </dd>
            {isAdmin && (action.requestAuditId || action.appliedAuditId) && (
              <>
                <dt className="text-muted-foreground">Audit log</dt>
                <dd>
                  <Link
                    to="/settings/audit"
                    search={{ pendingActionId: action.id }}
                    className="underline underline-offset-2"
                  >
                    {action.appliedAuditId ? "Request and applied result" : "Request"}
                  </Link>
                </dd>
              </>
            )}
          </dl>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-expanded={details}
        onClick={() => setDetails((v) => !v)}
      >
        {details ? "Hide" : "View"}
      </Button>
    </li>
  );
}
