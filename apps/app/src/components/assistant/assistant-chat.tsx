// The conversation view shared by the Cmd-J panel and /assistant (ADR 0200): the transcript
// (Markdown replies, tool calls folded away, pending changes with Approve / Reject for people who
// may approve them, test-mode reports of proposed automations), and the composer.
import type {
  AssistantContext,
  AssistantPending,
  TranscriptItem,
} from "@relationship-os/core/client";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FlaskConicalIcon,
  LoaderCircleIcon,
  SendIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "#/components/markdown";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import type { ConversationView } from "./use-conversation.ts";

/** A tool call's name for people: `person_get` → "person get", call_operation → its operation. */
function toolLabel(item: Extract<TranscriptItem, { kind: "tool" }>): string {
  const input = item.input as Record<string, unknown> | null;
  if (item.tool === "call_operation" && typeof input?.name === "string") return input.name;
  return item.tool.replace(/_/g, " ");
}

function PendingCard({ pending, canApprove }: { pending: AssistantPending; canApprove: boolean }) {
  const status = useOp("approval.status", { actionId: pending.actionId });
  const approve = useOpMutation("approval.approve", { invalidates: ["approval."] });
  const reject = useOpMutation("approval.reject", { invalidates: ["approval."] });
  const action = status.data?.changeSets
    .flatMap((s) => s.actions)
    .find((a) => a.id === pending.actionId);
  const state = action?.status ?? "pending";
  const busy = approve.isPending || reject.isPending;

  async function decide(kind: "approve" | "reject") {
    try {
      const result =
        kind === "approve"
          ? await approve.mutateAsync({ actionIds: [pending.actionId] })
          : await reject.mutateAsync({ actionIds: [pending.actionId] });
      const outcome = result.results[0]?.status ?? (kind === "approve" ? "applied" : "rejected");
      if (outcome === "failed") toast.error(result.results[0]?.statusReason ?? "It failed");
      else toast.success(kind === "approve" ? "Approved" : "Rejected");
      await status.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      data-testid="assistant-pending"
      data-status={state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{state === "pending" ? "Waiting for approval" : state}</Badge>
        <span className="font-medium">{pending.operation}</span>
      </div>
      {action?.reason && <p className="mt-1 text-muted-foreground">{action.reason}</p>}
      {action?.preview?.length ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {action.preview.slice(0, 5).map((p) => (
            <li key={`${p.object}:${p.id}`}>
              {p.action} {p.object} {p.id}
            </li>
          ))}
        </ul>
      ) : null}
      {state === "pending" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canApprove ? (
            <>
              <Button size="sm" onClick={() => decide("approve")} disabled={busy}>
                <CheckIcon />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide("reject")} disabled={busy}>
                <XIcon />
                Reject
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              Someone who can approve changes will review it.
            </span>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link to="/approvals" search={{ set: pending.changeSetId }}>
              Open in Approvals
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** automation.test's report, short: what the automation would do. */
function TestReport({ output }: { output: unknown }) {
  const report = (output as { report?: Record<string, unknown> } | null)?.report;
  if (!report) return null;
  const list = (key: string) => (Array.isArray(report[key]) ? (report[key] as unknown[]) : []);
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-xs" data-testid="assistant-test-report">
      <div className="mb-1 flex items-center gap-1 font-medium">
        <FlaskConicalIcon className="size-3.5" />
        Test mode: nothing was written
      </div>
      <ul className="space-y-0.5 text-muted-foreground">
        {typeof report.matchReason === "string" && <li>{report.matchReason}</li>}
        <li>
          {list("steps").length} steps · {list("writes").length} changes ·{" "}
          {list("notifications").length} notifications · {list("approvals").length} need approval
        </li>
        {report.ok === false && <li className="text-destructive">The run failed in test mode</li>}
      </ul>
    </div>
  );
}

function ToolItem({
  item,
  canApprove,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  canApprove: boolean;
}) {
  const [open, setOpen] = useState(false);
  const done = item.output !== undefined;
  return (
    <div className="space-y-2" data-testid="assistant-tool" data-tool={item.tool}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        {done ? (
          item.isError ? (
            <CircleAlertIcon className="size-3 text-destructive" />
          ) : (
            <WrenchIcon className="size-3" />
          )
        ) : (
          <LoaderCircleIcon className="size-3 animate-spin" />
        )}
        <span className="truncate">{toolLabel(item)}</span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">
          {JSON.stringify({ input: item.input, output: item.output }, null, 2)}
        </pre>
      )}
      {item.pending && <PendingCard pending={item.pending} canApprove={canApprove} />}
      {item.tool === "automation_test" && done && !item.isError && (
        <TestReport output={item.output} />
      )}
    </div>
  );
}

export function Transcript({
  items,
  name,
  canApprove,
  thinking,
  running,
}: {
  items: TranscriptItem[];
  name: string;
  canApprove: boolean;
  thinking: boolean;
  running: boolean;
}) {
  return (
    <ol className="space-y-4" aria-live="polite" data-testid="assistant-transcript">
      {items.map((item, index) => {
        const key = `${item.kind}-${item.turn}-${index}`;
        switch (item.kind) {
          case "user":
            return (
              <li key={key} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                  {item.text}
                </div>
              </li>
            );
          case "assistant":
            return (
              <li key={key} data-testid="assistant-reply">
                <span className="sr-only">{name}: </span>
                <Markdown>{item.text}</Markdown>
              </li>
            );
          case "tool":
            return (
              <li key={key}>
                <ToolItem item={item} canApprove={canApprove} />
              </li>
            );
          case "error":
            return (
              <li
                key={key}
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
              >
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                {item.message}
              </li>
            );
          default:
            return null;
        }
      })}
      {running && (
        <li className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3 animate-spin" />
          {thinking ? `${name} is thinking…` : `${name} is working…`}
        </li>
      )}
    </ol>
  );
}

/** What the next message is about, shown subtly above the composer: "On: Acme Ltd". */
function ContextChip({ context }: { context: AssistantContext }) {
  let label: string | undefined;
  if (context.selection) {
    const n = context.selection.ids.length;
    label = `${n} ${context.selection.object}${n === 1 ? "" : "s"} selected`;
  } else if (context.record) {
    label = context.record.label ?? `${context.record.object} ${context.record.id}`;
  } else {
    label = context.title;
  }
  if (!label) return null;
  return (
    <Badge
      variant="secondary"
      className="max-w-full font-normal text-muted-foreground"
      data-testid="assistant-context"
      title={label}
    >
      <span className="truncate">
        On: <span className="text-foreground">{label}</span>
      </span>
    </Badge>
  );
}

export function Composer({
  conversation,
  context,
  name,
  draft,
  onDraftChange,
  autoFocus,
}: {
  conversation: ConversationView;
  context: AssistantContext;
  name: string;
  draft: string;
  onDraftChange: (text: string) => void;
  /** Focuses the input when true, or each time this number changes (0: never). */
  autoFocus?: boolean | number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  async function submit() {
    const text = draft.trim();
    if (!text || conversation.running) return;
    onDraftChange("");
    await conversation.send(text, context);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ContextChip context={context} />
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Ask ${name}…`}
          aria-label={`Message ${name}`}
          rows={2}
          className="max-h-40 min-h-10 resize-none"
          data-testid="assistant-input"
        />
        {conversation.running ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => void conversation.stop()}
            aria-label="Stop"
          >
            <SquareIcon />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!draft.trim()}
            aria-label="Send"
            data-testid="assistant-send"
          >
            <SendIcon />
          </Button>
        )}
      </div>
      {conversation.error && <p className="text-xs text-destructive">{conversation.error}</p>}
    </form>
  );
}

/** Settings → General's name for the assistant (never "Claude"). */
export function useAssistantName(): string {
  const settings = useOp("settings.get", {}, { staleTime: 5 * 60_000 });
  return settings.data?.assistantName ?? "Assistant";
}
