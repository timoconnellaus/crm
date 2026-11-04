// A dashboard (ADR 0027, ADR 0057): its filter bar, and its widgets on a 12-column grid that
// stacks to one column on phones. Each widget runs through widget.run (60 s server cache, manual
// refresh), and offers its SQL (admins), a copy-ready "Ask the assistant" prompt, CSV export
// and, for editors, edit / move / resize / remove. Clicking a segment opens the matching list.
import {
  DATE_PRESETS,
  type DashboardFilter,
  type FilterValue,
  resolveClickThrough,
  type WidgetSpec,
} from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crm/ui/components/dropdown-menu";
import { Input } from "@crm/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  ExpandIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  ShrinkIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { downloadText } from "#/components/list/export-csv";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";
import { useObjectInfo } from "#/lib/schema";
import { useUsers } from "#/lib/users-adapter";
import { openFilteredList } from "./list-href.ts";
import { rowsToCsv, WidgetBody } from "./widget-renderers.tsx";

export type FilterValues = Record<string, FilterValue>;

export interface DashboardLike {
  id: string;
  title: string;
  canEdit: boolean;
  filters: DashboardFilter[];
  widgets: WidgetSpec[];
}

const PRESET_LABELS: Record<string, string> = {
  all_time: "All time",
  today: "Today",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
  last_365_days: "Last 365 days",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  this_year: "This year",
};
const ANY = "__any__";
const CUSTOM = "__custom__";

/** A filter's current value: the user's, else the filter's default. */
export function filterValue(filter: DashboardFilter, values: FilterValues): FilterValue {
  if (Object.hasOwn(values, filter.id)) return values[filter.id] ?? null;
  if (filter.type === "dateRange") return filter.default;
  if (filter.type === "user") return filter.default === "me" ? "me" : null;
  return filter.default ?? null;
}

export function DashboardFilters({
  filters,
  values,
  onChange,
}: {
  filters: DashboardFilter[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
}) {
  const users = useUsers();
  const set = (id: string, value: FilterValue) => onChange({ ...values, [id]: value });
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="dashboard-filters">
      {filters.map((filter) => {
        const value = filterValue(filter, values);
        switch (filter.type) {
          case "dateRange": {
            const custom = value && typeof value === "object" ? value : null;
            return (
              <div key={filter.id} className="flex flex-wrap items-center gap-1">
                <Select
                  value={custom ? CUSTOM : String(value ?? "all_time")}
                  onValueChange={(v) => {
                    if (v === CUSTOM) {
                      const to = new Date().toISOString().slice(0, 10);
                      const from = new Date(Date.now() - 30 * 86_400_000)
                        .toISOString()
                        .slice(0, 10);
                      set(filter.id, { from, to });
                    } else set(filter.id, v as FilterValue);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-40"
                    aria-label={filter.label}
                    data-testid={`filter-${filter.id}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_PRESETS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PRESET_LABELS[p] ?? p}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM}>Custom…</SelectItem>
                  </SelectContent>
                </Select>
                {custom && (
                  <>
                    <Input
                      type="date"
                      className="h-8 w-36"
                      aria-label={`${filter.label} from`}
                      value={custom.from}
                      onChange={(e) =>
                        e.target.value && set(filter.id, { ...custom, from: e.target.value })
                      }
                    />
                    <Input
                      type="date"
                      className="h-8 w-36"
                      aria-label={`${filter.label} to`}
                      value={custom.to}
                      onChange={(e) =>
                        e.target.value && set(filter.id, { ...custom, to: e.target.value })
                      }
                    />
                  </>
                )}
              </div>
            );
          }
          case "user":
            return (
              <Select
                key={filter.id}
                value={typeof value === "string" && value ? value : ANY}
                onValueChange={(v) => set(filter.id, v === ANY ? null : v)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-40"
                  aria-label={filter.label}
                  data-testid={`filter-${filter.id}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any {filter.label.toLowerCase()}</SelectItem>
                  <SelectItem value="me">Me</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          case "select":
            return (
              <Select
                key={filter.id}
                value={typeof value === "string" && value ? value : ANY}
                onValueChange={(v) => set(filter.id, v === ANY ? null : v)}
              >
                <SelectTrigger size="sm" className="w-40" aria-label={filter.label}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any {filter.label.toLowerCase()}</SelectItem>
                  {filter.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          case "field":
            return (
              <FieldFilter
                key={filter.id}
                filter={filter}
                value={typeof value === "string" ? value : null}
                onChange={(v) => set(filter.id, v)}
              />
            );
          default:
            return (
              <Input
                key={filter.id}
                className="h-8 w-40"
                placeholder={filter.label}
                aria-label={filter.label}
                defaultValue={typeof value === "string" ? value : ""}
                onBlur={(e) => set(filter.id, e.target.value || null)}
              />
            );
        }
      })}
    </div>
  );
}

function FieldFilter({
  filter,
  value,
  onChange,
}: {
  filter: Extract<DashboardFilter, { type: "field" }>;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { object } = useObjectInfo(filter.object);
  const field = object?.fields.find((f) => f.name === filter.field);
  const choices =
    (field?.options?.choices as { value: string; label?: string }[] | undefined)?.map((c) => ({
      value: c.value,
      label: c.label ?? c.value,
    })) ?? field?.enumValues?.map((v) => ({ value: v, label: v }));
  if (!choices) {
    return (
      <Input
        className="h-8 w-40"
        placeholder={filter.label}
        aria-label={filter.label}
        defaultValue={value ?? ""}
        onBlur={(e) => onChange(e.target.value || null)}
      />
    );
  }
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? null : v)}>
      <SelectTrigger size="sm" className="w-40" aria-label={filter.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any {filter.label.toLowerCase()}</SelectItem>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The copy-ready prompt for an MCP assistant about one widget. */
export function assistantPrompt(
  dashboard: DashboardLike,
  widget: WidgetSpec,
  values: FilterValues,
): string {
  return [
    `In my CRM, the dashboard "${dashboard.title}" (id ${dashboard.id}) has a ${widget.type} widget "${widget.title}" (widget id ${widget.id}).`,
    widget.sql ? `Its SQL:\n${widget.sql}` : "",
    Object.keys(values).length ? `Current filters: ${JSON.stringify(values)}` : "",
    "Using the CRM's MCP tools (dashboard.get, widget.preview, dashboard.update), help me with this widget: explain what it shows, or change it as I describe next.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const MIN_HEIGHT: Record<string, string> = {
  kpi: "min-h-28",
  markdown: "min-h-28",
};

function WidgetCard({
  dashboard,
  widget,
  values,
  recordId,
  isAdmin,
  editing,
  onEdit,
  onRemove,
  onMove,
  onResize,
}: {
  dashboard: DashboardLike;
  widget: WidgetSpec;
  values: FilterValues;
  recordId?: string | undefined;
  isAdmin: boolean;
  editing: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
  onMove?: (direction: -1 | 1) => void;
  onResize?: (delta: number) => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [showSql, setShowSql] = useState(false);
  const key = [
    "op",
    "widget.run",
    dashboard.id,
    widget.id,
    values,
    recordId ?? null,
    widget.sql ?? "",
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      callOp("widget.run", {
        dashboardId: dashboard.id,
        widgetId: widget.id,
        filters: values,
        ...(recordId ? { recordId } : {}),
      }),
    enabled: widget.type !== "markdown",
    staleTime: 60_000,
  });
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const fresh = await callOp("widget.run", {
        dashboardId: dashboard.id,
        widgetId: widget.id,
        filters: values,
        refresh: true,
        ...(recordId ? { recordId } : {}),
      });
      client.setQueryData(key, fresh);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  const select = widget.clickThrough
    ? (row: Record<string, unknown>) => {
        const target = resolveClickThrough(
          widget.clickThrough as never,
          row,
          query.data?.params ?? {},
        );
        void openFilteredList(navigate, target.object, target.filter);
      }
    : undefined;

  const w = widget.layout.w;
  const h = widget.layout.h;
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground md:[grid-column:span_var(--w)/span_var(--w)] md:[grid-row:span_var(--h)/span_var(--h)]",
        MIN_HEIGHT[widget.type] ?? "h-72 md:h-auto",
      )}
      style={{ "--w": w, "--h": h } as React.CSSProperties}
      aria-label={widget.title}
      data-testid={`widget-${widget.id}`}
    >
      <header className="flex items-center gap-2 px-4 pt-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{widget.title}</h2>
        {query.data?.cached && (
          <span className="text-[10px] text-muted-foreground" title={`Read ${query.data.cachedAt}`}>
            cached
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`${widget.title} actions`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {widget.type !== "markdown" && (
              <DropdownMenuItem onSelect={() => void refresh()} disabled={refreshing}>
                <RefreshCwIcon />
                Refresh
              </DropdownMenuItem>
            )}
            {widget.sql && (isAdmin || dashboard.canEdit) && (
              <DropdownMenuItem onSelect={() => setShowSql(true)}>
                <CodeIcon />
                View SQL
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                void navigator.clipboard
                  ?.writeText(assistantPrompt(dashboard, widget, values))
                  .then(() => toast.success("Prompt copied: paste it into your assistant"))
                  .catch(() => toast.error("Could not copy"));
              }}
            >
              <CopyIcon />
              Ask the assistant
            </DropdownMenuItem>
            {query.data && (
              <DropdownMenuItem
                onSelect={() =>
                  downloadText(`${widget.id}.csv`, rowsToCsv(query.data.columns, query.data.rows))
                }
              >
                <DownloadIcon />
                Export CSV
              </DropdownMenuItem>
            )}
            {editing && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilIcon />
                  Edit widget
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onMove?.(-1)}>
                  <ArrowUpIcon />
                  Move earlier
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onMove?.(1)}>
                  <ArrowDownIcon />
                  Move later
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onResize?.(2)} disabled={w >= 12}>
                  <ExpandIcon />
                  Wider
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onResize?.(-2)} disabled={w <= 2}>
                  <ShrinkIcon />
                  Narrower
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2Icon />
                  Remove
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="min-h-0 flex-1 px-4 pt-2 pb-3">
        {widget.type === "markdown" ? (
          <WidgetBody widget={widget} data={{ columns: [], rows: [], previous: null }} />
        ) : query.isPending ? (
          <Skeleton className="h-full min-h-16" />
        ) : query.isError ? (
          <div className="grid h-full content-center gap-2 text-sm" role="alert">
            <p className="text-destructive">{errorMessage(query.error)}</p>
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <WidgetBody
            widget={widget}
            data={{
              columns: query.data.columns,
              rows: query.data.rows,
              previous: query.data.previous,
            }}
            onSelect={select}
          />
        )}
      </div>
      <Dialog open={showSql} onOpenChange={setShowSql}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{widget.title}</DialogTitle>
            <DialogDescription>
              Read-only SQL over the crm_* views, with named parameters.
            </DialogDescription>
          </DialogHeader>
          <pre
            className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs"
            data-testid="widget-sql"
          >
            {widget.sql}
          </pre>
          {query.data && (
            <p className="text-xs text-muted-foreground">
              Parameters: <code>{JSON.stringify(query.data.params)}</code>
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** The widget grid: 12 columns from md up (rows of about 9rem), one column on phones. */
export function DashboardGrid({
  dashboard,
  values,
  recordId,
  isAdmin,
  editing = false,
  onWidgetsChange,
  onEditWidget,
}: {
  dashboard: DashboardLike;
  values: FilterValues;
  recordId?: string;
  isAdmin: boolean;
  editing?: boolean;
  onWidgetsChange?: (widgets: WidgetSpec[]) => void;
  onEditWidget?: (widget: WidgetSpec) => void;
}) {
  const widgets = dashboard.widgets;
  const change = (next: WidgetSpec[]) => onWidgetsChange?.(next);
  if (!widgets.length) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No widgets yet.{dashboard.canEdit ? " Add one to get started." : ""}
      </p>
    );
  }
  return (
    <div
      className="grid grid-cols-1 gap-4 md:auto-rows-[9rem] md:grid-cols-12"
      data-testid="dashboard-grid"
    >
      {widgets.map((widget, index) => (
        <WidgetCard
          key={widget.id}
          dashboard={dashboard}
          widget={widget}
          values={values}
          recordId={recordId}
          isAdmin={isAdmin}
          editing={editing}
          onEdit={() => onEditWidget?.(widget)}
          onRemove={() => change(widgets.filter((w) => w.id !== widget.id))}
          onMove={(direction) => {
            const target = index + direction;
            if (target < 0 || target >= widgets.length) return;
            const next = [...widgets];
            [next[index], next[target]] = [next[target] as WidgetSpec, next[index] as WidgetSpec];
            change(next);
          }}
          onResize={(delta) =>
            change(
              widgets.map((w) =>
                w.id === widget.id
                  ? {
                      ...w,
                      layout: { ...w.layout, w: Math.min(12, Math.max(2, w.layout.w + delta)) },
                    }
                  : w,
              ),
            )
          }
        />
      ))}
    </div>
  );
}

export function SharedBadge({ shared, builtIn }: { shared: boolean; builtIn?: boolean }) {
  if (builtIn) return <Badge variant="outline">Built in</Badge>;
  return shared ? (
    <Badge variant="outline">Shared</Badge>
  ) : (
    <Badge variant="secondary">Personal</Badge>
  );
}
