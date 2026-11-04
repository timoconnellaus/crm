// Settings → Audit log (admin): every write, refusal and non-human read (audit.list), newest
// first, in a virtualised list that loads more as you scroll, filtered by user, actor, operation,
// outcome, record and date (the filters fold into the fixed header). Each entry expands to its
// field diffs per record.
import { getObject } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LinkIcon, ListFilterIcon, LockIcon, ScrollTextIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { VirtualFeed } from "#/components/layout/infinite";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { diffValue } from "#/components/record/history";
import { formatDateTime } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { opKey } from "#/lib/query";
import { useUsers } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/settings/audit")({
  validateSearch: (search: Record<string, unknown>): { pendingActionId?: string } =>
    typeof search.pendingActionId === "string" && /^pac_[\w-]{1,60}$/.test(search.pendingActionId)
      ? { pendingActionId: search.pendingActionId }
      : {},
  component: AuditPage,
});

const ANY = "__any__";
const ACTORS = ["human", "assistant", "mcp", "automation"] as const;
const OUTCOMES = ["ok", "forbidden", "denied", "review", "error"] as const;
const RECORD_OBJECTS = ["person", "organisation", "activity", "task"] as const;

interface Filters {
  userId: string;
  actor: string;
  operation: string;
  outcome: string;
  object: string;
  recordId: string;
  /** Only the rows of one pending action: its queued request and applied result. */
  pendingActionId: string;
  from: string;
  to: string;
}

const EMPTY: Filters = {
  userId: ANY,
  actor: ANY,
  operation: "",
  outcome: ANY,
  object: ANY,
  recordId: "",
  pendingActionId: "",
  from: "",
  to: "",
};

/** `YYYY-MM-DD` (local) → ISO start of that day; `to` is exclusive, so it takes the next day. */
function dayStart(date: string, addDays = 0): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + addDays);
  return d.toISOString();
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function AuditPage() {
  const { isAdmin } = Route.useRouteContext();
  if (!isAdmin) {
    return (
      <PageLayout title="Audit log" width="xl" back={{ to: "/settings", label: "Settings" }}>
        <EmptyState icon={LockIcon} title="Admins only" description="Ask an admin for access." />
      </PageLayout>
    );
  }
  return <AuditLog />;
}

function AuditLog() {
  const users = useUsers();
  const { pendingActionId = "" } = Route.useSearch();
  const navigate = useNavigate({ from: "/settings/audit" });
  const [filters, setFilters] = useState<Filters>({ ...EMPTY, pendingActionId });
  // Following a link to a pending action (?pendingActionId=) filters to it.
  useEffect(() => {
    if (pendingActionId) setFilters((f) => ({ ...f, pendingActionId }));
  }, [pendingActionId]);
  const set = (key: keyof Filters, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const showPending = (id: string) => {
    navigate({ search: { pendingActionId: id } });
    set("pendingActionId", id);
  };
  const typed = useDebounced({ operation: filters.operation, recordId: filters.recordId }, 300);

  const operationValid = !typed.operation || /^[a-zA-Z0-9.]+(\.\*)?$/.test(typed.operation.trim());
  const input = useMemo(() => {
    const from = dayStart(filters.from);
    const to = dayStart(filters.to, 1);
    return {
      limit: 50,
      ...(filters.userId !== ANY ? { userId: filters.userId } : {}),
      ...(filters.actor !== ANY ? { actor: filters.actor as (typeof ACTORS)[number] } : {}),
      ...(filters.outcome !== ANY ? { outcome: filters.outcome as (typeof OUTCOMES)[number] } : {}),
      ...(typed.operation.trim() && operationValid ? { operation: typed.operation.trim() } : {}),
      ...(filters.object !== ANY ? { object: filters.object } : {}),
      ...(typed.recordId.trim() ? { recordId: typed.recordId.trim() } : {}),
      ...(/^pac_[\w-]{1,60}$/.test(filters.pendingActionId)
        ? { pendingActionId: filters.pendingActionId }
        : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
  }, [filters, typed, operationValid]);

  const log = useInfiniteQuery({
    queryKey: opKey("audit.list", input),
    queryFn: ({ pageParam }) =>
      callOp("audit.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
  });
  const entries = useMemo(() => log.data?.pages.flatMap((p) => p.items) ?? [], [log.data]);
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY);
  const activeFilters = (Object.keys(EMPTY) as (keyof Filters)[]).filter(
    (k) => filters[k] !== EMPTY[k],
  ).length;
  // The filters fold into the header; open when following a link that filters.
  const [showFilters, setShowFilters] = useState(filtered);

  const filter = (id: string, label: string, control: ReactNode) => (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {control}
    </div>
  );
  const select = (
    id: keyof Filters,
    label: string,
    anyLabel: string,
    options: { value: string; label: string }[],
  ) =>
    filter(
      `audit-${id}`,
      label,
      <Select value={filters[id]} onValueChange={(v) => set(id, v)}>
        <SelectTrigger id={`audit-${id}`} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{anyLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );

  return (
    <PageLayout
      title="Audit log"
      width="xl"
      back={{ to: "/settings", label: "Settings" }}
      count={
        <PageCount
          value={log.isSuccess ? entries.length : undefined}
          capped={log.hasNextPage}
          isPending={log.isPending}
          noun="entries"
        />
      }
      description="Every change, refusal and AI or automation read: who, through which operation, and what changed."
      actions={
        <Button
          variant="outline"
          size="sm"
          aria-expanded={showFilters}
          aria-controls="audit-filters"
          onClick={() => setShowFilters((v) => !v)}
        >
          <ListFilterIcon />
          Filters
          {activeFilters > 0 && <Badge variant="secondary">{activeFilters}</Badge>}
        </Button>
      }
      toolbar={
        showFilters ? (
          <fieldset
            id="audit-filters"
            className="grid max-h-[40dvh] w-full grid-cols-2 gap-3 overflow-y-auto rounded-md border p-3 sm:grid-cols-4"
            aria-label="Audit filters"
          >
            {select(
              "userId",
              "User",
              "Any user",
              users.map((u) => ({ value: u.id, label: u.name })),
            )}
            {select(
              "actor",
              "Actor",
              "Any actor",
              ACTORS.map((a) => ({ value: a, label: a })),
            )}
            {filter(
              "audit-operation",
              "Operation",
              <Input
                id="audit-operation"
                value={filters.operation}
                onChange={(e) => set("operation", e.target.value)}
                placeholder="person.* or task.complete"
                className="h-8"
                aria-invalid={!operationValid}
              />,
            )}
            {select(
              "outcome",
              "Outcome",
              "Any outcome",
              OUTCOMES.map((o) => ({ value: o, label: o })),
            )}
            {select(
              "object",
              "Record type",
              "Any type",
              RECORD_OBJECTS.map((o) => ({ value: o, label: o })),
            )}
            {filter(
              "audit-record",
              "Record id",
              <Input
                id="audit-record"
                value={filters.recordId}
                onChange={(e) => set("recordId", e.target.value)}
                placeholder="per_…"
                className="h-8"
              />,
            )}
            {filter(
              "audit-pending",
              "Pending action",
              <Input
                id="audit-pending"
                value={filters.pendingActionId}
                onChange={(e) => set("pendingActionId", e.target.value.trim())}
                placeholder="pac_…"
                className="h-8"
              />,
            )}
            {filter(
              "audit-from",
              "From",
              <Input
                id="audit-from"
                type="date"
                value={filters.from}
                onChange={(e) => set("from", e.target.value)}
                className="h-8"
              />,
            )}
            {filter(
              "audit-to",
              "To",
              <Input
                id="audit-to"
                type="date"
                value={filters.to}
                onChange={(e) => set("to", e.target.value)}
                className="h-8"
              />,
            )}
            {filtered && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="col-span-2 justify-self-start sm:col-span-4"
                onClick={() => {
                  setFilters(EMPTY);
                  if (pendingActionId) navigate({ search: {}, replace: true });
                }}
              >
                Clear filters
              </Button>
            )}
          </fieldset>
        ) : undefined
      }
    >
      {log.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : log.isError && !entries.length ? (
        <ErrorState
          title="Could not load the audit log"
          error={log.error}
          onRetry={() => void log.refetch()}
        />
      ) : !entries.length ? (
        <EmptyState
          icon={ScrollTextIcon}
          title={filtered ? "No matching entries" : "No entries yet"}
        />
      ) : (
        <VirtualFeed
          label="Audit entries"
          items={entries}
          getKey={(entry) => entry.id}
          estimateSize={44}
          source={log}
          className="rounded-md border"
          itemClassName="border-b last:border-b-0"
          renderItem={(entry) => (
            <AuditRow
              entry={entry}
              onShowPending={showPending}
              showingPending={Boolean(filters.pendingActionId)}
            />
          )}
        />
      )}
    </PageLayout>
  );
}

type AuditEntry = Awaited<ReturnType<typeof callOp<"audit.list">>>["items"][number];

/** The change set a queued request went into (its result names it). */
function changeSetOf(entry: AuditEntry): string | null {
  const result = entry.result as { changeSetId?: unknown } | null;
  return typeof result?.changeSetId === "string" ? result.changeSetId : null;
}

/**
 * Links between a pending action's audit rows: the queued request (outcome `review`) and, once
 * approved, the applied result (gate `review`, outcome `ok`), both carrying pendingActionId.
 */
function PendingLink({
  entry,
  onShow,
  showing,
}: {
  entry: AuditEntry;
  onShow: (pendingActionId: string) => void;
  showing: boolean;
}) {
  if (!entry.pendingActionId) return null;
  const queued = entry.outcome === "review";
  const changeSetId = changeSetOf(entry);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground"
      data-testid="pending-link"
    >
      <LinkIcon className="size-3.5" aria-hidden />
      <span>
        {queued ? "Queued for approval as " : "Applied on approval of "}
        <code className="font-mono">{entry.pendingActionId}</code>
      </span>
      {!showing && (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => onShow(entry.pendingActionId as string)}
        >
          {queued ? "Show the applied result" : "Show the queued request"}
        </button>
      )}
      {changeSetId && (
        <Link
          to="/approvals"
          search={{ set: changeSetId, tab: "history" }}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Open change set
        </Link>
      )}
    </div>
  );
}

function AuditRow({
  entry,
  onShowPending,
  showingPending,
}: {
  entry: AuditEntry;
  onShowPending: (pendingActionId: string) => void;
  showingPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const changed = entry.changes.filter((c) => Object.keys(c.diff).length > 0);
  const expandable = changed.length > 0;
  return (
    <div className="grid gap-2 px-3 py-2 text-sm" data-testid="audit-entry">
      <button
        type="button"
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 text-left",
          !expandable && "cursor-default",
        )}
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <ChevronRightIcon
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            open && "rotate-90",
            !expandable && "invisible",
          )}
          aria-hidden
        />
        <code className="font-mono text-xs font-medium">{entry.operation}</code>
        <Badge variant={entry.outcome === "ok" ? "outline" : "destructive"}>{entry.outcome}</Badge>
        <span className="text-muted-foreground">
          {entry.userName ?? entry.userId ?? "unknown"}
          {entry.actor !== "human" ? ` via ${entry.actor}` : ""}
        </span>
        {changed.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {changed.length} record{changed.length === 1 ? "" : "s"} changed
          </span>
        )}
        <time dateTime={entry.at} className="ml-auto text-xs text-muted-foreground">
          {formatDateTime(entry.at)}
        </time>
      </button>
      <PendingLink entry={entry} onShow={onShowPending} showing={showingPending} />
      {open && (
        <div className="grid gap-3 pl-6" data-testid="audit-diffs">
          {changed.map((change) => {
            const object = getObject(change.object);
            return (
              <div
                key={`${change.object}:${change.recordId}:${change.action}`}
                className="grid gap-1"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{change.action}</Badge>
                  <span>{change.object}</span>
                  <code className="font-mono">{change.recordId}</code>
                </div>
                <dl className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                  {Object.entries(change.diff).map(([field, diff]) => (
                    <div key={field} className="contents">
                      <dt className="text-muted-foreground">
                        {object?.fields.find((f) => f.name === field)?.label ?? field}
                      </dt>
                      <dd className="min-w-0 break-words">
                        <span className="text-muted-foreground line-through">
                          {diffValue(diff.before)}
                        </span>{" "}
                        → {diffValue(diff.after)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
