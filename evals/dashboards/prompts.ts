// The 10 "build me a chart of…" prompts (stage 4a). Each is answerable on any seeded database
// (people, organisations, activities and tasks from packages/db/src/seed.ts; the seed sets no
// owners or assignees, so nothing here groups by them). A task declares the widget types that
// fit the request, optionally a few extra checks on the final widget and its rows, and a
// reference widget: a known-good answer the smoke script previews against a deployment and the
// unit tests feed through the grader.
import type { WidgetSpec, WidgetType } from "./lib/core.ts";

/** What widget.preview returns, as far as grading looks. */
export interface PreviewResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface DashboardTask {
  id: string;
  title: string;
  /** What the user types, as into the in-app "Describe a widget" box. */
  prompt: string;
  /** Widget types that fit the request; the first is the most natural. */
  accept: WidgetType[];
  /** Extra checks on the final widget and its rows: failure reasons, empty when fine. */
  expect?(widget: WidgetSpec, preview: PreviewResult): string[];
  /** A correct answer, over the Overview dashboard's filters (date, owner). */
  reference: WidgetSpec;
}

const limitOf = (widget: WidgetSpec): number | null =>
  typeof widget.options?.limit === "number" ? widget.options.limit : null;

/** At most `n` rows shown: the query returns ≤ n rows, or options.limit caps it at ≤ n. */
const atMost = (n: number) => (widget: WidgetSpec, preview: PreviewResult) => {
  const limit = limitOf(widget);
  return preview.rowCount <= n || (limit !== null && limit <= n)
    ? []
    : [`asked for the top ${n}, but the widget shows ${preview.rowCount} rows (no limit ≤ ${n})`];
};

export const tasks: DashboardTask[] = [
  {
    id: "tasks-by-status",
    title: "Tasks by status, bar chart",
    prompt: "Show tasks by status as a bar chart.",
    accept: ["bar"],
    reference: {
      id: "tasks-by-status",
      type: "bar",
      title: "Tasks by status",
      sql: "SELECT status AS label, COUNT(*) AS value FROM crm_tasks GROUP BY status ORDER BY status",
      mapping: { x: "label", y: "value" },
    },
  },
  {
    id: "activity-share",
    title: "Share of activities by type",
    prompt: "What share of our activities is each type (calls, emails, meetings, notes)?",
    accept: ["donut", "bar"],
    reference: {
      id: "activity-share",
      type: "donut",
      title: "Activities by type",
      sql: "SELECT type AS label, COUNT(*) AS value FROM crm_activities WHERE type <> 'system' GROUP BY type ORDER BY value DESC",
      mapping: { label: "label", value: "value" },
    },
  },
  {
    id: "people-this-month",
    title: "People added this month vs last",
    prompt: "The number of people added this month, compared with last month.",
    accept: ["kpi"],
    reference: {
      id: "people-this-month",
      type: "kpi",
      title: "People added this month",
      sql: "SELECT COUNT(*) AS value FROM crm_people WHERE created_at >= substr(:today, 1, 7) || '-01'",
      mapping: { value: "value" },
    },
  },
  {
    id: "people-trend",
    title: "New people over time",
    prompt: "Show the trend of new people added over time, month by month.",
    accept: ["line", "bar"],
    expect: (widget) =>
      widget.mapping?.x ? [] : ["a trend over time needs the month on the x axis (mapping.x)"],
    reference: {
      id: "people-trend",
      type: "line",
      title: "People added by month",
      sql: "SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS value FROM crm_people GROUP BY month ORDER BY month",
      mapping: { x: "month", y: "value" },
    },
  },
  {
    id: "top-organisations",
    title: "Top 5 organisations by people",
    prompt: "The top 5 organisations by number of current people.",
    accept: ["leaderboard", "table", "bar"],
    expect: atMost(5),
    reference: {
      id: "top-organisations",
      type: "leaderboard",
      title: "Top organisations",
      sql: "SELECT name AS label, current_people_count AS value FROM crm_organisations ORDER BY current_people_count DESC LIMIT 5",
      mapping: { label: "label", value: "value" },
      options: { limit: 5 },
    },
  },
  {
    id: "task-funnel",
    title: "Task status funnel",
    prompt:
      "A pipeline-like funnel of tasks: all tasks, then those with a due date, then those completed.",
    accept: ["funnel", "bar"],
    expect: (_widget, preview) =>
      preview.rowCount >= 2 ? [] : [`a funnel needs stages, but it has ${preview.rowCount} row(s)`],
    reference: {
      id: "task-funnel",
      type: "funnel",
      title: "Tasks",
      sql:
        "SELECT 'All tasks' AS label, COUNT(*) AS value FROM crm_tasks " +
        "UNION ALL SELECT 'With a due date', COUNT(*) FROM crm_tasks WHERE due_at IS NOT NULL " +
        "UNION ALL SELECT 'Done', COUNT(*) FROM crm_tasks WHERE status = 'done'",
      mapping: { label: "label", value: "value" },
    },
  },
  {
    id: "activities-by-month-and-type",
    title: "Activities per month, split by type",
    prompt: "Chart the activities logged each month, split by activity type.",
    accept: ["line", "bar"],
    expect: (widget) =>
      widget.mapping?.series || Array.isArray(widget.mapping?.y)
        ? []
        : ["split by type needs a series column or several y columns"],
    reference: {
      id: "activities-by-month-and-type",
      type: "bar",
      title: "Activities by month",
      sql:
        "SELECT substr(occurred_at, 1, 7) AS month, type, COUNT(*) AS value FROM crm_activities " +
        "WHERE type <> 'system' GROUP BY month, type ORDER BY month, type",
      mapping: { x: "month", y: "value", series: "type" },
      options: { stacked: true },
    },
  },
  {
    id: "overdue-tasks",
    title: "Overdue open tasks",
    prompt: "How many open tasks are overdue right now?",
    accept: ["kpi"],
    reference: {
      id: "overdue-tasks",
      type: "kpi",
      title: "Overdue tasks",
      sql: "SELECT COUNT(*) AS value FROM crm_tasks WHERE status = 'open' AND due_at < :now",
      mapping: { value: "value" },
      options: { compare: false },
    },
  },
  {
    id: "organisations-by-industry",
    title: "Organisations by industry, horizontal bars",
    prompt: "Organisations by industry, as a horizontal bar chart.",
    accept: ["bar"],
    expect: (widget) =>
      widget.options?.orientation === "horizontal"
        ? []
        : ['asked for horizontal bars, but options.orientation is not "horizontal"'],
    reference: {
      id: "organisations-by-industry",
      type: "bar",
      title: "Organisations by industry",
      sql: "SELECT coalesce(industry, 'Unknown') AS label, COUNT(*) AS value FROM crm_organisations GROUP BY label ORDER BY value DESC",
      mapping: { x: "label", y: "value" },
      options: { orientation: "horizontal" },
    },
  },
  {
    id: "tasks-due-soon",
    title: "Open tasks due soonest, table",
    prompt: "A table of the 10 open tasks due soonest, with their title and due date.",
    accept: ["table"],
    expect: atMost(10),
    reference: {
      id: "tasks-due-soon",
      type: "table",
      title: "Due soonest",
      sql: "SELECT title, due_at FROM crm_tasks WHERE status = 'open' AND due_at IS NOT NULL ORDER BY due_at LIMIT 10",
      mapping: { columns: ["title", "due_at"] },
    },
  },
];
