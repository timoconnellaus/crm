// The thread view shared by the docked sidebar and /assistant (ADR 0200, ADR 0340): the
// transcript (Markdown replies, tool calls folded away, pending changes with Approve / Reject for
// people who may approve them, test-mode reports of proposed automations, day dividers, times,
// and Delete on each message), "Search this chat", and the composer.
import type {
  AssistantContext,
  AssistantPending,
  TranscriptItem,
} from "@relationship-os/core/client";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Input } from "@relationship-os/ui/components/input";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FlaskConicalIcon,
  LoaderCircleIcon,
  SearchIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "#/components/markdown";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import type { ThreadView } from "./thread-provider.tsx";

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

/** "Today", "Yesterday", or the date, for the divider before a new day's messages. */
function dayLabel(at: string): string {
  const day = new Date(at);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

function timeLabel(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The time under a message, and Delete when it is stored. */
function Meta({
  at,
  seq,
  onDelete,
  align = "start",
  label,
}: {
  at?: string | undefined;
  seq?: number | undefined;
  onDelete?: ((seq: number) => void) | undefined;
  align?: "start" | "end";
  label: string;
}) {
  if (!at && seq === undefined) return null;
  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-1 text-xs text-muted-foreground",
        align === "end" && "justify-end",
      )}
    >
      {at && <time dateTime={at}>{timeLabel(at)}</time>}
      {seq !== undefined && onDelete && (
        <button
          type="button"
          className="rounded p-0.5 opacity-0 group-hover/msg:opacity-100 hover:text-foreground focus-visible:opacity-100"
          aria-label={`Delete ${label}`}
          data-testid="assistant-delete"
          onClick={() => onDelete(seq)}
        >
          <Trash2Icon className="size-3" />
        </button>
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
  onDelete,
  before,
}: {
  items: TranscriptItem[];
  name: string;
  canApprove: boolean;
  thinking: boolean;
  running: boolean;
  /** Deletes a stored message (a reply goes as a whole). */
  onDelete?: (seq: number) => void;
  /** Shown above the first message ("Show earlier messages"). */
  before?: ReactNode;
}) {
  let lastDay = "";
  return (
    <ol className="space-y-4" aria-live="polite" data-testid="assistant-transcript">
      {before && <li>{before}</li>}
      {items.map((item, index) => {
        const key = `${item.kind}-${item.turn}-${item.seq ?? `i${index}`}`;
        const day = item.at ? dayLabel(item.at) : "";
        const divider =
          day && day !== lastDay ? (
            <li
              className="text-center text-xs font-medium text-muted-foreground"
              data-testid="assistant-day"
            >
              {day}
            </li>
          ) : null;
        if (day) lastDay = day;
        const seqAttr = item.seq !== undefined ? { "data-seq": item.seq } : {};
        let row: ReactNode = null;
        switch (item.kind) {
          case "user":
            row = (
              <li
                className="group/msg flex flex-col items-end"
                data-testid="assistant-user"
                {...seqAttr}
              >
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                  {item.text}
                </div>
                <Meta
                  at={item.at}
                  seq={item.seq}
                  onDelete={onDelete}
                  align="end"
                  label="your message"
                />
              </li>
            );
            break;
          case "assistant":
            row = (
              <li className="group/msg" data-testid="assistant-reply" {...seqAttr}>
                <span className="sr-only">{name}: </span>
                <Markdown>{item.text}</Markdown>
                <Meta at={item.at} seq={item.seq} onDelete={onDelete} label={`${name}'s reply`} />
              </li>
            );
            break;
          case "tool":
            row = (
              <li {...seqAttr}>
                <ToolItem item={item} canApprove={canApprove} />
              </li>
            );
            break;
          case "error":
            row = (
              <li className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                {item.message}
              </li>
            );
            break;
          default:
            row = null;
        }
        return (
          <Fragment key={key}>
            {divider}
            {row}
          </Fragment>
        );
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

/** Highlights each search term in `text` (as the person typed them, case-insensitive). */
function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu",
  );
  // Segments keyed by where they start in the text; odd ones are the matches.
  let offset = 0;
  const segments = text.split(pattern).map((part, i) => {
    const segment = { at: offset, part, hit: i % 2 === 1 };
    offset += part.length;
    return segment;
  });
  return (
    <>
      {segments.map((s) =>
        s.hit ? (
          <mark
            key={s.at}
            className="rounded-sm bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-500/30"
          >
            {s.part}
          </mark>
        ) : (
          <span key={s.at}>{s.part}</span>
        ),
      )}
    </>
  );
}

/**
 * "Search this chat" (thread.search): the whole thread, newest first, each hit with who and when,
 * and "Jump to" it.
 */
export function ThreadSearch({
  query,
  onQueryChange,
  name,
  onJump,
  autoFocus,
  className,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  name: string;
  onJump: (seq: number) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useOp(
    "thread.search",
    { query: debounced, limit: 30 },
    { enabled: debounced.length > 0, staleTime: 0 },
  );
  const hits = results.data?.hits ?? [];
  return (
    <div className={cn("space-y-2", className)} data-testid="assistant-search">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search this chat"
          aria-label="Search this chat"
          className="pl-8"
          autoFocus={autoFocus}
          data-testid="assistant-search-input"
        />
        {debounced && results.data && (
          <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
            {hits.length} result{hits.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {debounced &&
        results.data &&
        (hits.length ? (
          <ul className="divide-y rounded-md border" data-testid="assistant-search-results">
            {hits.map((hit) => (
              <li key={hit.seq} className="space-y-1 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {hit.role === "user" ? "You" : name} · {dayLabel(hit.at)}, {timeLabel(hit.at)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-xs"
                    onClick={() => onJump(hit.seq)}
                  >
                    Jump to
                  </Button>
                </div>
                <p className="text-sm">
                  <Highlighted text={hit.text} query={debounced} />
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing in your chat matches that.</p>
        ))}
    </div>
  );
}

/** Scrolls a jumped-to message into view and flashes it, once it is loaded. */
export function useJumpToMessage(thread: ThreadView, root: HTMLElement | null) {
  const { jumpTarget, clearJump, items } = thread;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retried when new items arrive.
  useEffect(() => {
    if (jumpTarget === null || !root) return;
    const all = [...root.querySelectorAll<HTMLElement>("[data-seq]")];
    const target =
      all.find((el) => Number(el.dataset.seq) === jumpTarget) ??
      all.find((el) => Number(el.dataset.seq) >= jumpTarget);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("ring-2", "ring-ring", "rounded-md");
    setTimeout(() => target.classList.remove("ring-2", "ring-ring", "rounded-md"), 1600);
    clearJump();
  }, [jumpTarget, root, items]);
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
  conversation: ThreadView;
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
