// Widget renderers (ADR 0027, ADR 0057): KPI (with the previous period), bar/column, line/area,
// donut/pie, funnel, table (top N), leaderboard and markdown, over a widget's result rows and
// chart mapping. Charts use the shadcn chart components (Recharts) and the --chart-N colours,
// which are redefined for dark mode. Clicking a KPI, a bar, a point, a segment or a row calls
// `onSelect` with the result row behind it (the click-through).
import type { WidgetSpec } from "@crm/core/client";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@crm/ui/components/chart";
import { cn } from "@crm/ui/lib/utils";
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { Markdown } from "#/components/markdown";

export type Row = Record<string, unknown>;

export interface WidgetData {
  columns: string[];
  rows: Row[];
  previous: { rows: Row[] } | null;
}

const COLORS = 5;
export const seriesColor = (index: number) => `var(--chart-${(index % COLORS) + 1})`;

/** Formats a number by the widget's format option. */
export function formatNumber(value: unknown, widget: Pick<WidgetSpec, "options">): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || Number.isNaN(n))
    return value == null ? "—" : String(value);
  const { format, currency } = widget.options;
  try {
    if (format === "currency") {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: currency ?? "USD",
        maximumFractionDigits: 0,
      }).format(n);
    }
    if (format === "percent")
      return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(n)}%`;
  } catch {
    // Fall through to a plain number.
  }
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n);
}

const asArray = (y: string | string[] | undefined) =>
  y === undefined ? [] : Array.isArray(y) ? y : [y];
const isNumeric = (rows: Row[], column: string) =>
  rows.some((r) => typeof r[column] === "number") &&
  rows.every((r) => r[column] == null || typeof r[column] === "number");

/** The category column and value columns a bar/line widget plots. */
function axes(widget: WidgetSpec, data: WidgetData) {
  const x = widget.mapping.x ?? widget.mapping.label ?? data.columns[0] ?? "x";
  let ys = asArray(widget.mapping.y);
  if (!ys.length && widget.mapping.value) ys = [widget.mapping.value];
  if (!ys.length)
    ys = data.columns.filter(
      (c) => c !== x && c !== widget.mapping.series && isNumeric(data.rows, c),
    );
  return { x, ys };
}

interface Plot {
  data: Row[];
  keys: { key: string; label: string }[];
  /** The result row behind a plotted point. */
  rowAt: (index: number, key: string) => Row | undefined;
}

/** Wide data for Recharts: long-format rows (x, series, value) are pivoted into one row per x. */
function plot(widget: WidgetSpec, data: WidgetData): Plot & { x: string } {
  const { x, ys } = axes(widget, data);
  const series = widget.mapping.series;
  if (!series) {
    return {
      x,
      data: data.rows.map((row) => ({ ...row, __x: row[x] == null ? "—" : String(row[x]) })),
      keys: ys.map((y) => ({ key: y, label: y })),
      rowAt: (index) => data.rows[index],
    };
  }
  const y = ys[0] ?? "value";
  const names = [...new Set(data.rows.map((r) => String(r[series] ?? "—")))];
  const keyOf = new Map(names.map((name, i) => [name, `s${i}`]));
  const byX = new Map<string, Row>();
  const source = new Map<string, Row>();
  for (const row of data.rows) {
    const xv = row[x] == null ? "—" : String(row[x]);
    const key = keyOf.get(String(row[series] ?? "—")) as string;
    const entry = byX.get(xv) ?? { __x: xv };
    entry[key] = row[y];
    byX.set(xv, entry);
    source.set(`${xv}\u0000${key}`, row);
  }
  const rows = [...byX.values()];
  return {
    x,
    data: rows,
    keys: names.map((name) => ({ key: keyOf.get(name) as string, label: name })),
    rowAt: (index, key) => source.get(`${String(rows[index]?.__x)}\u0000${key}`),
  };
}

function chartConfig(keys: { key: string; label: string }[]): ChartConfig {
  return Object.fromEntries(keys.map((k, i) => [k.key, { label: k.label, color: seriesColor(i) }]));
}

export function WidgetBody({
  widget,
  data,
  onSelect,
}: {
  widget: WidgetSpec;
  data: WidgetData;
  onSelect?: ((row: Row) => void) | undefined;
}) {
  if (widget.type === "markdown")
    return <Markdown className="h-full overflow-y-auto">{widget.markdown ?? ""}</Markdown>;
  if (!data.rows.length) {
    return <p className="grid h-full place-items-center text-sm text-muted-foreground">No data</p>;
  }
  switch (widget.type) {
    case "kpi":
      return <Kpi widget={widget} data={data} onSelect={onSelect} />;
    case "bar":
      return <BarWidget widget={widget} data={data} onSelect={onSelect} />;
    case "line":
      return <LineWidget widget={widget} data={data} onSelect={onSelect} />;
    case "donut":
      return <DonutWidget widget={widget} data={data} onSelect={onSelect} />;
    case "funnel":
      return <RankedBars widget={widget} data={data} onSelect={onSelect} funnel />;
    case "leaderboard":
      return <RankedBars widget={widget} data={data} onSelect={onSelect} />;
    case "table":
      return <TableWidget widget={widget} data={data} onSelect={onSelect} />;
    default:
      return null;
  }
}

type Props = { widget: WidgetSpec; data: WidgetData; onSelect?: ((row: Row) => void) | undefined };

function Kpi({ widget, data, onSelect }: Props) {
  const column =
    widget.mapping.value ??
    data.columns.find((c) => isNumeric(data.rows, c)) ??
    data.columns[0] ??
    "value";
  const row = data.rows[0] ?? {};
  const value = Number(row[column] ?? 0);
  const before = data.previous?.rows[0]?.[column];
  const previous = before === undefined || before === null ? null : Number(before);
  const change =
    previous === null
      ? null
      : previous === 0
        ? value === 0
          ? 0
          : null
        : ((value - previous) / Math.abs(previous)) * 100;
  const Icon =
    change === null || change === 0
      ? MinusIcon
      : change > 0
        ? ArrowUpRightIcon
        : ArrowDownRightIcon;
  const content = (
    <>
      <span className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="kpi-value">
        {formatNumber(value, widget)}
      </span>
      {previous !== null && (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs",
            change !== null && change > 0 && "text-success",
            change !== null && change < 0 && "text-destructive",
            (change === null || change === 0) && "text-muted-foreground",
          )}
          data-testid="kpi-change"
        >
          <Icon className="size-3.5" aria-hidden />
          {change === null ? "new" : `${change > 0 ? "+" : ""}${change.toFixed(0)}%`}
          <span className="text-muted-foreground">vs {formatNumber(previous, widget)} before</span>
        </span>
      )}
    </>
  );
  return onSelect ? (
    <button
      type="button"
      className="grid w-full content-center justify-items-start gap-1 rounded-md text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onSelect(row)}
      aria-label={`Open the ${formatNumber(value, widget)} records counted in ${widget.title}`}
    >
      {content}
    </button>
  ) : (
    <div className="grid content-center gap-1">{content}</div>
  );
}

function BarWidget({ widget, data, onSelect }: Props) {
  const p = useMemo(() => plot(widget, data), [widget, data]);
  const horizontal = widget.options.orientation === "horizontal";
  const config = chartConfig(p.keys);
  return (
    <ChartContainer config={config} className="aspect-auto h-full w-full">
      <BarChart data={p.data} layout={horizontal ? "vertical" : "horizontal"} accessibilityLayer>
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <YAxis dataKey="__x" type="category" width={110} tickLine={false} axisLine={false} />
            <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
          </>
        ) : (
          <>
            <XAxis dataKey="__x" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
          </>
        )}
        <ChartTooltip
          content={<ChartTooltipContent valueFormatter={(v) => formatNumber(v, widget)} />}
        />
        {p.keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {p.keys.map((k) => (
          <Bar
            key={k.key}
            dataKey={k.key}
            name={k.label}
            fill={`var(--color-${k.key})`}
            radius={4}
            stackId={widget.options.stacked ? "a" : undefined}
            className={onSelect ? "cursor-pointer" : undefined}
            onClick={(_entry: unknown, index: number) => {
              const row = p.rowAt(index, k.key);
              if (row && onSelect) onSelect(row);
            }}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

function LineWidget({ widget, data, onSelect }: Props) {
  const p = useMemo(() => plot(widget, data), [widget, data]);
  const config = chartConfig(p.keys);
  const area = widget.options.area;
  const Chart = area ? AreaChart : LineChart;
  const dot = (key: string) => ({
    r: 5,
    className: onSelect ? "cursor-pointer" : undefined,
    onClick: (_event: unknown, payload: unknown) => {
      const index = (payload as { index?: number })?.index ?? -1;
      const row = p.rowAt(index, key);
      if (row && onSelect) onSelect(row);
    },
  });
  return (
    <ChartContainer config={config} className="aspect-auto h-full w-full">
      <Chart data={p.data} accessibilityLayer margin={{ left: 4, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="__x" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
        <ChartTooltip
          content={<ChartTooltipContent valueFormatter={(v) => formatNumber(v, widget)} />}
        />
        {p.keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {p.keys.map((k) =>
          area ? (
            <Area
              key={k.key}
              dataKey={k.key}
              name={k.label}
              type="monotone"
              stroke={`var(--color-${k.key})`}
              fill={`var(--color-${k.key})`}
              fillOpacity={0.2}
              stackId={widget.options.stacked ? "a" : undefined}
              dot={{ r: 3 }}
              activeDot={dot(k.key)}
            />
          ) : (
            <Line
              key={k.key}
              dataKey={k.key}
              name={k.label}
              type="monotone"
              stroke={`var(--color-${k.key})`}
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={dot(k.key)}
            />
          ),
        )}
      </Chart>
    </ChartContainer>
  );
}

function labelValue(widget: WidgetSpec, data: WidgetData) {
  const label = widget.mapping.label ?? widget.mapping.x ?? data.columns[0] ?? "label";
  const value =
    widget.mapping.value ??
    asArray(widget.mapping.y)[0] ??
    data.columns.find((c) => c !== label && isNumeric(data.rows, c)) ??
    "value";
  return { label, value };
}

function DonutWidget({ widget, data, onSelect }: Props) {
  const { label, value } = labelValue(widget, data);
  const slices = data.rows.map((row, i) => ({
    key: `k${i}`,
    name: row[label] == null ? "—" : String(row[label]),
    value: Number(row[value] ?? 0),
    fill: `var(--color-k${i})`,
  }));
  const config: ChartConfig = Object.fromEntries(
    slices.map((s, i) => [s.key, { label: s.name, color: seriesColor(i) }]),
  );
  return (
    <ChartContainer config={config} className="aspect-auto h-full w-full">
      <PieChart accessibilityLayer>
        <ChartTooltip
          content={
            <ChartTooltipContent
              nameKey="key"
              hideLabel
              valueFormatter={(v) => formatNumber(v, widget)}
            />
          }
        />
        <Pie
          data={slices}
          dataKey="value"
          nameKey="key"
          innerRadius={widget.options.pie ? 0 : "55%"}
          outerRadius="85%"
          strokeWidth={2}
          className={onSelect ? "cursor-pointer" : undefined}
          onClick={(_entry: unknown, index: number) => {
            const row = data.rows[index];
            if (row && onSelect) onSelect(row);
          }}
        >
          {slices.map((s) => (
            <Cell key={s.key} fill={s.fill} data-testid="donut-segment" />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="key" />} />
      </PieChart>
    </ChartContainer>
  );
}

/** Funnel stages and leaderboard rows: labelled bars, widest first, each clickable. */
function RankedBars({ widget, data, onSelect, funnel }: Props & { funnel?: boolean }) {
  const { label, value } = labelValue(widget, data);
  const max = Math.max(1, ...data.rows.map((r) => Number(r[value] ?? 0)));
  const first = Number(data.rows[0]?.[value] ?? 0);
  return (
    <ol className="grid content-start gap-1.5 overflow-y-auto" aria-label={widget.title}>
      {data.rows.map((row, i) => {
        const n = Number(row[value] ?? 0);
        const width = `${Math.max(2, (n / max) * 100)}%`;
        const name = row[label] == null ? "—" : String(row[label]);
        const inner = (
          <>
            <span className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">
                {!funnel && (
                  <span className="mr-1.5 text-muted-foreground tabular-nums">{i + 1}.</span>
                )}
                {name}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatNumber(n, widget)}
                {funnel && i > 0 && first > 0 && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    ({Math.round((n / first) * 100)}%)
                  </span>
                )}
              </span>
            </span>
            <span
              className={cn("block h-2 rounded-full", funnel && "mx-auto")}
              style={{ width, backgroundColor: seriesColor(funnel ? i : 0) }}
            />
          </>
        );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; rows have no key.
          <li key={`${name}-${i}`}>
            {onSelect ? (
              <button
                type="button"
                className="grid w-full gap-1 rounded px-1 py-0.5 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => onSelect(row)}
                data-testid="ranked-row"
              >
                {inner}
              </button>
            ) : (
              <div className="grid gap-1 px-1 py-0.5">{inner}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function looksLikeDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value);
}
const shortDate = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

function TableWidget({ widget, data, onSelect }: Props) {
  const columns = widget.mapping.columns?.length
    ? widget.mapping.columns
    : data.columns.filter((c) => c !== "id");
  const cell = (value: unknown) => {
    if (value === null || value === undefined || value === "")
      return <span className="text-muted-foreground">—</span>;
    if (typeof value === "number") return formatNumber(value, widget);
    if (looksLikeDate(value)) {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : shortDate.format(date);
    }
    return String(value);
  };
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-left text-xs text-muted-foreground">
            {columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable key.
              key={i}
              className={cn(
                "border-b last:border-0",
                onSelect && "cursor-pointer hover:bg-accent/50",
              )}
              onClick={onSelect ? () => onSelect(row) : undefined}
              onKeyDown={
                onSelect
                  ? (event) => {
                      if (event.key === "Enter") onSelect(row);
                    }
                  : undefined
              }
              tabIndex={onSelect ? 0 : undefined}
              data-testid="widget-table-row"
            >
              {columns.map((c) => (
                <td key={c} className="max-w-48 truncate px-2 py-1.5">
                  {cell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rows as CSV text (RFC 4180 quoting), for "Export CSV". */
export function rowsToCsv(columns: string[], rows: Row[]): string {
  const quote = (value: unknown) => {
    const text =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.map(quote).join(","),
    ...rows.map((row) => columns.map((c) => quote(row[c])).join(",")),
  ].join("\r\n");
}
