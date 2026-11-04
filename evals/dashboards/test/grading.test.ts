import type { RecordedCall } from "@crm/evals-mcp/lib/agent.ts";
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  checkMapping,
  createdDashboards,
  finalCandidate,
  gradeCandidate,
  mappingColumns,
  previewWidget,
} from "../lib/grading.ts";
import { tasks } from "../prompts.ts";
import { fakeCrm, selectColumns } from "./fake-crm.ts";

const task = (id: string) => {
  const found = tasks.find((t) => t.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

let turn = 0;
function call(
  name: string,
  input: Record<string, unknown>,
  isError = false,
  result: unknown = null,
): RecordedCall {
  turn += 1;
  return { promptIndex: 0, turn, name, input, isError, resultText: "", result };
}
const preview = (widget: Record<string, unknown>, isError = false, extra = {}) =>
  call("call_operation", { name: "widget.preview", input: { widget, ...extra } }, isError);

const bar = { id: "b", type: "bar", title: "B", sql: "SELECT 1", mapping: { x: "a", y: "b" } };
const kpi = { id: "k", type: "kpi", title: "K", sql: "SELECT 1", mapping: { value: "v" } };
const date = [{ type: "dateRange", id: "date", label: "Date" }];

describe("finalCandidate", () => {
  it("takes the last successful widget.preview, over a later failed one", () => {
    const candidate = finalCandidate([
      preview(kpi, true),
      preview(bar, false, { dashboardFilters: date, filters: { date: "this_month" } }),
      call("query_sql", { sql: "SELECT 1" }),
      preview(kpi, true),
    ]);
    expect(candidate).toEqual({
      widget: bar,
      dashboardFilters: date,
      filters: { date: "this_month" },
      source: "widget.preview",
      modelPreviewOk: true,
    });
  });

  it("falls back to the last attempted preview when none succeeded", () => {
    const candidate = finalCandidate([preview(bar, true), preview(kpi, true)]);
    expect(candidate?.widget).toEqual(kpi);
    expect(candidate?.modelPreviewOk).toBe(false);
    expect(candidate?.dashboardFilters).toEqual([]);
  });

  it("accepts a curated widget_preview tool too", () => {
    const candidate = finalCandidate([call("widget_preview", { widget: kpi })]);
    expect(candidate?.widget).toEqual(kpi);
  });

  it("falls back to the last widget saved with dashboard.create", () => {
    const candidate = finalCandidate([
      call("call_operation", {
        name: "dashboard.create",
        input: { title: "D", filters: date, widgets: [kpi, bar] },
      }),
    ]);
    expect(candidate).toMatchObject({
      widget: bar,
      dashboardFilters: date,
      source: "dashboard.create",
    });
  });

  it("is null when the model wrote no widget", () => {
    expect(finalCandidate([call("query_sql", { sql: "SELECT 1" })])).toBeNull();
    expect(
      finalCandidate([call("call_operation", { name: "widget.preview", input: {} })]),
    ).toBeNull();
  });
});

describe("createdDashboards", () => {
  it("lists the ids of successful dashboard.create calls", () => {
    expect(
      createdDashboards([
        call("call_operation", { name: "dashboard.create", input: {} }, false, { id: "dsh_1" }),
        call("call_operation", { name: "dashboard.create", input: {} }, true, null),
        call("call_operation", { name: "widget.preview", input: {} }, false, { id: "x" }),
      ]),
    ).toEqual(["dsh_1"]);
  });
});

describe("mapping", () => {
  it("lists every mapped column", () => {
    expect(mappingColumns({ x: "m", y: ["a", "b"], series: "s" })).toEqual([
      { key: "x", column: "m" },
      { key: "y", column: "a" },
      { key: "y", column: "b" },
      { key: "series", column: "s" },
    ]);
  });

  it("needs the keys the type draws with, naming real columns", () => {
    expect(
      checkMapping({ type: "bar", mapping: { x: "label", y: "value" } }, ["label", "value"]),
    ).toEqual([]);
    expect(checkMapping({ type: "bar", mapping: { x: "label" } }, ["label", "value"])).toEqual([
      "a bar widget needs mapping.y",
    ]);
    expect(checkMapping({ type: "donut", mapping: {} }, [])).toEqual([
      "a donut widget needs mapping.label and mapping.value",
    ]);
    expect(checkMapping({ type: "kpi", mapping: { value: "count" } }, ["value"])).toEqual([
      "mapping names columns the query does not return: value → count (columns: value)",
    ]);
    expect(checkMapping({ type: "table", mapping: {} }, ["a"])).toEqual([]);
  });
});

describe("gradeCandidate", () => {
  const candidate = (widget: Record<string, unknown>): Candidate => ({
    widget,
    dashboardFilters: [],
    filters: {},
    source: "widget.preview",
    modelPreviewOk: true,
  });
  const rows = (columns: string[], count = 3) => ({
    ok: true as const,
    result: {
      columns,
      rows: Array.from({ length: count }, () => ({})),
      rowCount: count,
      truncated: false,
    },
  });

  it("passes a fitting widget that runs with a sound mapping", () => {
    const widget = { ...bar, mapping: { x: "label", y: "value" } };
    expect(
      gradeCandidate(task("tasks-by-status"), candidate(widget), rows(["label", "value"])),
    ).toEqual([]);
  });

  it("fails each criterion with its own kind", () => {
    expect(gradeCandidate(task("tasks-by-status"), null, null)).toEqual([
      { kind: "no-widget", message: "the model produced no widget" },
    ]);
    expect(
      gradeCandidate(
        task("tasks-by-status"),
        candidate({ ...kpi, mapping: { value: "value" } }),
        rows(["value"]),
      ),
    ).toEqual([{ kind: "type", message: "chart type kpi does not fit; accepted: bar" }]);
    expect(
      gradeCandidate(task("people-this-month"), candidate(kpi), {
        ok: false,
        error: "no such column: x",
      }),
    ).toEqual([{ kind: "sql", message: "the widget does not run: no such column: x" }]);
    expect(
      gradeCandidate(task("people-this-month"), candidate(kpi), rows(["value"], 1)).map(
        (f) => f.kind,
      ),
    ).toEqual(["mapping"]);
  });

  it("applies the task's own expectations", () => {
    const top = task("top-organisations");
    const leaderboard = {
      id: "l",
      type: "leaderboard",
      title: "L",
      sql: "x",
      mapping: { label: "n", value: "v" },
    };
    expect(gradeCandidate(top, candidate(leaderboard), rows(["n", "v"], 5))).toEqual([]);
    expect(gradeCandidate(top, candidate(leaderboard), rows(["n", "v"], 20))).toEqual([
      {
        kind: "expectation",
        message: "asked for the top 5, but the widget shows 20 rows (no limit ≤ 5)",
      },
    ]);
    expect(
      gradeCandidate(
        top,
        candidate({ ...leaderboard, options: { limit: 5 } }),
        rows(["n", "v"], 20),
      ),
    ).toEqual([]);
    const industry = task("organisations-by-industry");
    const vertical = { ...bar, mapping: { x: "label", y: "value" } };
    expect(gradeCandidate(industry, candidate(vertical), rows(["label", "value"]))).toEqual([
      {
        kind: "expectation",
        message: 'asked for horizontal bars, but options.orientation is not "horizontal"',
      },
    ]);
  });
});

describe("previewWidget", () => {
  it("re-runs the widget through call_operation(widget.preview) with fresh rows", async () => {
    const crm = fakeCrm();
    const session = crm.session();
    const widget = {
      ...kpi,
      sql: "SELECT COUNT(*) AS value FROM crm_people",
      mapping: { value: "value" },
    };
    const result = await previewWidget(session, { widget, dashboardFilters: [], filters: {} });
    expect(result).toEqual({
      ok: true,
      result: { columns: ["value"], rows: [{ value: 0 }], rowCount: 1, truncated: false },
    });
    expect(session.calls).toEqual([
      {
        name: "call_operation",
        args: {
          name: "widget.preview",
          input: { widget, dashboardFilters: [], filters: {}, refresh: true },
        },
      },
    ]);
  });

  it("returns the server's error message when the SQL is refused", async () => {
    const session = fakeCrm().session();
    const widget = {
      ...kpi,
      sql: "SELECT COUNT(*) AS value FROM crm_people WHERE created_at >= :date_from",
    };
    expect(await previewWidget(session, { widget, dashboardFilters: [], filters: {} })).toEqual({
      ok: false,
      error: "unknown parameter :date_from",
    });
  });
});

describe("the fake CRM's column inference", () => {
  it("reads aliases and bare columns from the select list", () => {
    expect(
      selectColumns("SELECT substr(created_at, 1, 7) AS month, type, COUNT(*) AS value FROM crm_x"),
    ).toEqual(["month", "type", "value"]);
  });
});
