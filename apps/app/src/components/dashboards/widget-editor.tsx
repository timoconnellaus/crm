// The widget editor (ADR 0059): "Describe a widget" (a prompt → the build model role → a
// validated, previewed widget) and the manual editor (type, title, SQL with a schema sidebar,
// column mapping, options, click-through), both previewing through widget.preview before the
// widget is saved to the dashboard.
import {
  type DashboardFilter,
  WIDGET_TYPES,
  type WidgetSpec,
  type WidgetType,
} from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";
import { useSchemaObjects } from "#/lib/schema";
import type { FilterValues } from "./dashboard-view.tsx";
import { WidgetBody } from "./widget-renderers.tsx";

type Preview = Awaited<ReturnType<typeof callOp<"widget.preview">>>;

const TYPE_LABELS: Record<WidgetType, string> = {
  kpi: "KPI",
  bar: "Bar / column",
  line: "Line / area",
  donut: "Donut / pie",
  funnel: "Funnel",
  table: "Table (top N)",
  leaderboard: "Leaderboard",
  markdown: "Markdown text",
};
const NONE = "__none__";

export function newWidget(): WidgetSpec {
  return {
    id: `w-${Math.random().toString(36).slice(2, 8)}`,
    type: "kpi",
    title: "New widget",
    sql: "SELECT COUNT(*) AS value FROM crm_people",
    mapping: { value: "value" },
    options: {},
    layout: { w: 4, h: 2 },
  };
}

export function WidgetEditor({
  open,
  initial,
  filters,
  values,
  onCancel,
  onSave,
}: {
  open: boolean;
  initial: WidgetSpec;
  filters: DashboardFilter[];
  values: FilterValues;
  onCancel: () => void;
  onSave: (widget: WidgetSpec) => void;
}) {
  const [widget, setWidget] = useState<WidgetSpec>(initial);
  const [tab, setTab] = useState<"describe" | "manual">("manual");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [clickThrough, setClickThrough] = useState(
    initial.clickThrough ? JSON.stringify(initial.clickThrough, null, 2) : "",
  );

  const set = (patch: Partial<WidgetSpec>) => {
    setWidget((w) => ({ ...w, ...patch }));
    setPreview(null);
  };
  const setMapping = (key: keyof WidgetSpec["mapping"], value: string | undefined) =>
    set({ mapping: { ...widget.mapping, [key]: value } });

  function withClickThrough(): WidgetSpec | null {
    if (!clickThrough.trim()) return { ...widget, clickThrough: null };
    try {
      return { ...widget, clickThrough: JSON.parse(clickThrough) };
    } catch {
      setError("The click-through is not valid JSON");
      return null;
    }
  }

  async function runPreview(spec: WidgetSpec | null = withClickThrough()) {
    if (!spec) return null;
    setBusy(true);
    setError(null);
    try {
      const result = await callOp("widget.preview", {
        widget: spec,
        dashboardFilters: filters,
        filters: values,
      });
      setPreview(result);
      return result;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function describeWidget() {
    setBusy(true);
    setError(null);
    setAiMessage(null);
    try {
      const result = await callOp("widget.describe", {
        prompt,
        dashboardFilters: filters,
        filters: values,
      });
      if (result.status === "unavailable") {
        setAiMessage(result.message);
      } else if (result.status === "invalid") {
        setAiMessage(`The model's widget did not pass the checks: ${result.message}`);
        if (result.widget) {
          setWidget({ ...result.widget, layout: widget.layout });
          setTab("manual");
        }
      } else {
        const next = { ...result.widget, layout: widget.layout };
        setWidget(next);
        setClickThrough(next.clickThrough ? JSON.stringify(next.clickThrough, null, 2) : "");
        setPreview(result.preview);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const spec = withClickThrough();
    if (!spec) return;
    if (spec.type !== "markdown" && !(await runPreview(spec))) return;
    onSave(spec);
  }

  const columns = preview?.columns ?? [];
  const mappingKeys: (keyof WidgetSpec["mapping"])[] =
    widget.type === "kpi"
      ? ["value"]
      : widget.type === "bar" || widget.type === "line"
        ? ["x", "y", "series"]
        : widget.type === "table"
          ? []
          : widget.type === "markdown"
            ? []
            : ["label", "value"];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-5xl"
        data-testid="widget-editor"
      >
        <DialogHeader>
          <DialogTitle>
            {initial.title === "New widget" ? "Add a widget" : `Edit ${initial.title}`}
          </DialogTitle>
          <DialogDescription>
            Describe the chart you want, or write read-only SQL over the crm_* views yourself.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="describe">
              <SparklesIcon />
              Describe a widget
            </TabsTrigger>
            <TabsTrigger value="manual">Manual</TabsTrigger>
          </TabsList>
          <TabsContent value="describe" className="grid gap-3 pt-3">
            <Label htmlFor="widget-prompt">What should it show?</Label>
            <Textarea
              id="widget-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. a bar chart of tasks by status"
              rows={3}
            />
            <Button
              className="justify-self-start"
              disabled={busy || prompt.trim().length < 3}
              onClick={() => void describeWidget()}
              data-testid="describe-widget"
            >
              <SparklesIcon />
              {busy ? "Building…" : "Build widget"}
            </Button>
            {aiMessage && (
              <p
                className="rounded-md border p-3 text-sm text-muted-foreground"
                role="status"
                data-testid="describe-message"
              >
                {aiMessage}
              </p>
            )}
            {preview && tab === "describe" && (
              <div className="grid gap-2">
                <p className="text-sm">
                  <span className="font-medium">{widget.title}</span>{" "}
                  <span className="text-muted-foreground">({TYPE_LABELS[widget.type]})</span>
                </p>
                <div className="h-56 rounded-lg border p-3" data-testid="widget-preview">
                  <WidgetBody widget={widget} data={{ ...preview, previous: preview.previous }} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => setTab("manual")}
                >
                  Edit it by hand
                </Button>
              </div>
            )}
          </TabsContent>
          <TabsContent
            value="manual"
            className="grid gap-4 pt-3 lg:grid-cols-[minmax(0,1fr)_16rem]"
          >
            <div className="grid content-start gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="widget-title">Title</Label>
                  <Input
                    id="widget-title"
                    value={widget.title}
                    onChange={(e) => set({ title: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Type</Label>
                  <Select
                    value={widget.type}
                    onValueChange={(type) => set({ type: type as WidgetType })}
                  >
                    <SelectTrigger aria-label="Widget type" data-testid="widget-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WIDGET_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {widget.type === "markdown" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="widget-markdown">Text (Markdown)</Label>
                  <Textarea
                    id="widget-markdown"
                    rows={6}
                    value={widget.markdown ?? ""}
                    onChange={(e) => set({ markdown: e.target.value, sql: null })}
                  />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="widget-sql">SQL</Label>
                  <Textarea
                    id="widget-sql"
                    rows={8}
                    className="font-mono text-xs"
                    value={widget.sql ?? ""}
                    onChange={(e) => set({ sql: e.target.value })}
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground">
                    Parameters:{" "}
                    {[
                      ":now",
                      ":today",
                      ":me",
                      ...filters.flatMap((f) =>
                        f.type === "dateRange" ? [`:${f.id}_from`, `:${f.id}_to`] : [`:${f.id}`],
                      ),
                    ].join(", ")}
                  </p>
                </div>
              )}
              {widget.type !== "markdown" && (
                <div className="grid gap-3 sm:grid-cols-3">
                  {mappingKeys.map((key) => (
                    <div key={key} className="grid gap-1.5">
                      <Label className="capitalize">{key}</Label>
                      <Select
                        value={(widget.mapping[key] as string | undefined) ?? NONE}
                        onValueChange={(v) => setMapping(key, v === NONE ? undefined : v)}
                      >
                        <SelectTrigger size="sm" aria-label={`${key} column`}>
                          <SelectValue placeholder="Preview to pick" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Automatic</SelectItem>
                          {[
                            ...new Set([
                              ...columns,
                              ...((widget.mapping[key] as string | undefined)
                                ? [widget.mapping[key] as string]
                                : []),
                            ]),
                          ].map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  {widget.type === "bar" && (
                    <Label className="flex items-center gap-2 font-normal">
                      <Checkbox
                        checked={widget.options.orientation === "horizontal"}
                        onCheckedChange={(c) =>
                          set({
                            options: {
                              ...widget.options,
                              orientation: c === true ? "horizontal" : "vertical",
                            },
                          })
                        }
                      />
                      Horizontal bars
                    </Label>
                  )}
                  {widget.type === "line" && (
                    <Label className="flex items-center gap-2 font-normal">
                      <Checkbox
                        checked={Boolean(widget.options.area)}
                        onCheckedChange={(c) =>
                          set({ options: { ...widget.options, area: c === true } })
                        }
                      />
                      Area
                    </Label>
                  )}
                  {widget.type === "donut" && (
                    <Label className="flex items-center gap-2 font-normal">
                      <Checkbox
                        checked={Boolean(widget.options.pie)}
                        onCheckedChange={(c) =>
                          set({ options: { ...widget.options, pie: c === true } })
                        }
                      />
                      Full pie
                    </Label>
                  )}
                  {(widget.type === "table" || widget.type === "leaderboard") && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="widget-limit">Top N</Label>
                      <Input
                        id="widget-limit"
                        type="number"
                        min={1}
                        max={100}
                        value={widget.options.limit ?? 10}
                        onChange={(e) =>
                          set({
                            options: { ...widget.options, limit: Number(e.target.value) || 10 },
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              )}
              {widget.type !== "markdown" && (
                <details className="grid gap-1.5">
                  <summary className="cursor-pointer text-sm">Click-through (advanced)</summary>
                  <Textarea
                    rows={5}
                    className="mt-2 font-mono text-xs"
                    value={clickThrough}
                    onChange={(e) => setClickThrough(e.target.value)}
                    placeholder={
                      '{ "object": "task", "filter": { "field": "status", "op": "eq", "value": { "$row": "label" } } }'
                    }
                    aria-label="Click-through JSON"
                  />
                </details>
              )}
              {error && (
                <p className="text-sm text-destructive" role="alert" data-testid="widget-error">
                  {error}
                </p>
              )}
              {preview && (
                <div className="h-56 rounded-lg border p-3" data-testid="widget-preview">
                  <WidgetBody widget={widget} data={{ ...preview, previous: preview.previous }} />
                </div>
              )}
            </div>
            <SchemaSidebar />
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {widget.type !== "markdown" && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void runPreview()}
              data-testid="preview-widget"
            >
              Preview
            </Button>
          )}
          <Button
            disabled={busy || !widget.title.trim()}
            onClick={() => void save()}
            data-testid="save-widget"
          >
            Save widget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The crm_* views and their columns, for writing SQL. */
function SchemaSidebar() {
  const schema = useSchemaObjects();
  return (
    <aside
      className="max-h-[28rem] overflow-y-auto rounded-lg border p-3 text-xs"
      aria-label="Schema"
    >
      <p className="mb-2 font-medium">Views</p>
      {(schema.data?.objects ?? []).map((object) => (
        <details key={object.name} className="mb-1">
          <summary className="cursor-pointer font-mono">{object.view}</summary>
          <ul className="mt-1 grid gap-0.5 pl-3 text-muted-foreground">
            {object.fields
              .filter((f) => !f.multi)
              .map((f) => (
                <li key={f.name} className="font-mono">
                  {f.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^[a-z]+\./, "")}{" "}
                  <span className="font-sans">({f.fieldType ?? f.type})</span>
                </li>
              ))}
          </ul>
        </details>
      ))}
      <p className="mt-2 text-muted-foreground">
        Also: crm_users, crm_affiliations, crm_activity_links, crm_task_links, crm_record_tags.
      </p>
    </aside>
  );
}
