// Grading one dashboard prompt. The widget graded is the model's final answer: in agent mode the
// widget of its last successful widget.preview call (else its last attempted one, else the last
// widget it put in a dashboard.create / dashboard.update); in describe mode the widget parsed from
// its last JSON answer. The grader then re-runs that widget through widget.preview on its own MCP
// connection, rather than trusting the model's preview, and checks:
//   (a) sql:      the SQL runs (the preview returns rows and columns, not a validation error);
//   (b) type:     the chart type is one the task accepts;
//   (c) mapping:  the chart mapping names columns the preview returned, and sets the ones the
//                 type needs (kpi → value, bar/line → x and y, …);
//   plus the task's own expectations (a top-5 shows five rows, horizontal bars are horizontal).
import type { RecordedCall } from "@relationship-os/evals-mcp/lib/agent.ts";
import { callMatches } from "@relationship-os/evals-mcp/lib/grading.ts";
import type { McpSession } from "@relationship-os/evals-mcp/lib/mcp.ts";
import { parseResult } from "@relationship-os/evals-mcp/lib/mcp.ts";
import type { DashboardTask, PreviewResult } from "../prompts.ts";
import type { DashboardFilter, WidgetMapping, WidgetSpec } from "./core.ts";

export type FailureKind = "no-widget" | "sql" | "type" | "mapping" | "expectation" | "error";

export interface Failure {
  kind: FailureKind;
  message: string;
}

/** A widget to grade, with the dashboard filters and values it was previewed with. */
export interface Candidate {
  widget: WidgetSpec;
  dashboardFilters: DashboardFilter[];
  filters: Record<string, unknown>;
  /** Where it came from: "widget.preview", "dashboard.create", "describe". */
  source: string;
  /** Whether the model's own preview of it succeeded (describe mode: its in-app preview). */
  modelPreviewOk: boolean;
}

/** The grader's preview: rows and columns, or the error widget.preview gave. */
export type GraderPreview = { ok: true; result: PreviewResult } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The operation input of a call, whether through call_operation or a curated tool. */
export function operationInput(call: RecordedCall): Record<string, unknown> {
  if (call.name === "call_operation") return isRecord(call.input.input) ? call.input.input : {};
  return call.input;
}

const filtersOf = (value: unknown): DashboardFilter[] =>
  Array.isArray(value) ? (value.filter(isRecord) as DashboardFilter[]) : [];

/** The model's final widget from its recorded tool calls, or null when it never wrote one. */
export function finalCandidate(calls: RecordedCall[]): Candidate | null {
  const previews = calls.filter((c) => callMatches("op:widget.preview", c));
  const withWidget = previews.filter((c) => isRecord(operationInput(c).widget));
  const chosen = withWidget.filter((c) => !c.isError).at(-1) ?? withWidget.at(-1);
  if (chosen) {
    const input = operationInput(chosen);
    return {
      widget: input.widget as WidgetSpec,
      dashboardFilters: filtersOf(input.dashboardFilters),
      filters: isRecord(input.filters) ? input.filters : {},
      source: "widget.preview",
      modelPreviewOk: !chosen.isError,
    };
  }
  // No preview: fall back to the last widget saved on a dashboard.
  for (const call of [...calls].reverse()) {
    const operation = callMatches("op:dashboard.create", call)
      ? "dashboard.create"
      : callMatches("op:dashboard.update", call)
        ? "dashboard.update"
        : null;
    if (!operation) continue;
    const input = operationInput(call);
    const widgets = Array.isArray(input.widgets) ? input.widgets.filter(isRecord) : [];
    const widget = widgets.at(-1);
    if (widget) {
      return {
        widget: widget as WidgetSpec,
        dashboardFilters: filtersOf(input.filters),
        filters: {},
        source: operation,
        modelPreviewOk: false,
      };
    }
  }
  return null;
}

/** Dashboards the model created successfully (ids from the results), to delete afterwards. */
export function createdDashboards(calls: RecordedCall[]): string[] {
  return calls
    .filter((c) => callMatches("op:dashboard.create", c) && !c.isError)
    .map((c) => (isRecord(c.result) && typeof c.result.id === "string" ? c.result.id : null))
    .filter((id): id is string => id !== null);
}

/** The error message of a failed tool result ({ error: { message } }), or its text. */
export function errorMessage(text: string): string {
  const parsed = parseResult(text);
  if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message;
  }
  return text.slice(0, 500);
}

/** Runs widget.preview on the grader's connection (fresh rows, not the 60 s cache). */
export async function previewWidget(
  session: McpSession,
  candidate: Pick<Candidate, "widget" | "dashboardFilters" | "filters">,
): Promise<GraderPreview> {
  const answer = await session.callTool("call_operation", {
    name: "widget.preview",
    input: {
      widget: candidate.widget,
      dashboardFilters: candidate.dashboardFilters,
      filters: candidate.filters,
      refresh: true,
    },
  });
  if (answer.isError) return { ok: false, error: errorMessage(answer.text) };
  const data = parseResult(answer.text);
  if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    return { ok: false, error: `widget.preview returned no rows: ${answer.text.slice(0, 300)}` };
  }
  return {
    ok: true,
    result: {
      columns: data.columns.map(String),
      rows: data.rows.filter(isRecord),
      rowCount: typeof data.rowCount === "number" ? data.rowCount : data.rows.length,
      truncated: Boolean(data.truncated),
    },
  };
}

/** The mapping keys each chart type needs to draw anything. */
export const REQUIRED_MAPPING: Record<string, (keyof WidgetMapping)[]> = {
  kpi: ["value"],
  bar: ["x", "y"],
  line: ["x", "y"],
  donut: ["label", "value"],
  funnel: ["label", "value"],
  leaderboard: ["label", "value"],
  table: [],
};

/** Every column the mapping names, with the key that names it. */
export function mappingColumns(mapping: WidgetMapping = {}): { key: string; column: string }[] {
  const out: { key: string; column: string }[] = [];
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value === "string") out.push({ key, column: value });
    else if (Array.isArray(value)) {
      for (const column of value) if (typeof column === "string") out.push({ key, column });
    }
  }
  return out;
}

/** Mapping failures: missing keys for the type, and names that are not result columns. */
export function checkMapping(widget: WidgetSpec, columns: string[]): string[] {
  const mapping = widget.mapping ?? {};
  const failures: string[] = [];
  const missing = (REQUIRED_MAPPING[widget.type ?? ""] ?? []).filter((key) => !mapping[key]);
  if (missing.length) {
    failures.push(`a ${widget.type} widget needs mapping.${missing.join(" and mapping.")}`);
  }
  const unknown = mappingColumns(mapping).filter(({ column }) => !columns.includes(column));
  if (unknown.length) {
    failures.push(
      `mapping names columns the query does not return: ${unknown
        .map(({ key, column }) => `${key} → ${column}`)
        .join(", ")} (columns: ${columns.join(", ") || "none"})`,
    );
  }
  return failures;
}

/** Grades a candidate against the task, given the grader's own preview of it. */
export function gradeCandidate(
  task: DashboardTask,
  candidate: Candidate | null,
  preview: GraderPreview | null,
): Failure[] {
  if (!candidate) {
    return [{ kind: "no-widget", message: "the model produced no widget" }];
  }
  const failures: Failure[] = [];
  const type = candidate.widget.type ?? "(none)";
  if (!task.accept.includes(type as never)) {
    failures.push({
      kind: "type",
      message: `chart type ${type} does not fit; accepted: ${task.accept.join(", ")}`,
    });
  }
  if (!preview) {
    failures.push({ kind: "sql", message: "the widget does not run: not previewed" });
    return failures;
  }
  if (!preview.ok) {
    failures.push({ kind: "sql", message: `the widget does not run: ${preview.error}` });
    return failures;
  }
  for (const message of checkMapping(candidate.widget, preview.result.columns)) {
    failures.push({ kind: "mapping", message });
  }
  for (const message of task.expect?.(candidate.widget, preview.result) ?? []) {
    failures.push({ kind: "expectation", message });
  }
  return failures;
}
