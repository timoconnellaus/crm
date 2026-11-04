// The shipped "Overview" dashboard (stage 4a): core data at a glance, and every user's default
// Home. It lives in code, not D1, so its SQL ships and upgrades with the release; anyone can
// copy it into an editable dashboard (`dashboard.create` with `copyFrom`).
//
// Every query walks an index (ADR 0057, packages/core/test/dashboards-rows-read.test.ts):
// people and organisations by the live created_at indexes (migration 0080), activities by
// (occurred_at, id), tasks by (status, due_at). Each widget's click-through filter selects
// exactly the records it counts (packages/core/test/dashboards.test.ts).
import type { DashboardSpec } from "./spec.ts";

export const OVERVIEW_DASHBOARD_ID = "dsh_overview";

const OWNER = "(:owner IS NULL OR owner_id = :owner)";
const IN_RANGE = "created_at >= :date_from AND created_at < :date_to";
const WEEK = "strftime('%Y-%m-%dT%H:%M:%fZ', :now, '+7 days')";
const MIN = "'0000-01-01T00:00:00.000Z'";
const MAX = "'9999-12-31T23:59:59.999Z'";

const createdInRange = (owner = true) => ({
  and: [
    { field: "createdAt", op: "gte" as const, value: { $param: "date_from" } },
    { field: "createdAt", op: "lt" as const, value: { $param: "date_to" } },
    ...(owner ? [{ field: "ownerId", op: "eq" as const, value: { $param: "owner" } }] : []),
  ],
});

// Activities: `type <> 'system'` rather than `type IN (...)`, which the planner (D1 keeps no
// ANALYZE statistics) would answer from the type index, reading every activity of those types
// whatever the date range.
export const OVERVIEW_DASHBOARD: {
  id: string;
  title: string;
  description: string;
  spec: DashboardSpec;
} = {
  id: OVERVIEW_DASHBOARD_ID,
  title: "Overview",
  description: "People and organisations added, activity, and tasks due, across the CRM.",
  spec: {
    filters: [
      { type: "dateRange", id: "date", label: "Date", default: "last_90_days" },
      { type: "user", id: "owner", label: "Owner", default: "anyone" },
    ],
    widgets: [
      {
        id: "people-added",
        type: "kpi",
        title: "People added",
        sql: `SELECT COUNT(*) AS value FROM crm_people WHERE ${IN_RANGE} AND ${OWNER}`,
        mapping: { value: "value" },
        options: { compare: true },
        clickThrough: { object: "person", filter: createdInRange() },
        layout: { w: 3, h: 1 },
      },
      {
        id: "organisations-added",
        type: "kpi",
        title: "Organisations added",
        sql: `SELECT COUNT(*) AS value FROM crm_organisations WHERE ${IN_RANGE} AND ${OWNER}`,
        mapping: { value: "value" },
        options: { compare: true },
        clickThrough: { object: "organisation", filter: createdInRange() },
        layout: { w: 3, h: 1 },
      },
      {
        id: "activities-logged",
        type: "kpi",
        title: "Activities logged",
        sql:
          "SELECT COUNT(*) AS value FROM crm_activities " +
          "WHERE occurred_at >= :date_from AND occurred_at < :date_to " +
          "AND type <> 'system' " +
          "AND (:owner IS NULL OR author_user_id = :owner)",
        mapping: { value: "value" },
        options: { compare: true },
        clickThrough: {
          object: "activity",
          filter: {
            and: [
              { field: "type", op: "neq", value: "system" },
              { field: "occurredAt", op: "gte", value: { $param: "date_from" } },
              { field: "occurredAt", op: "lt", value: { $param: "date_to" } },
              { field: "authorUserId", op: "eq", value: { $param: "owner" } },
            ],
          },
        },
        layout: { w: 3, h: 1 },
      },
      {
        id: "tasks-overdue",
        type: "kpi",
        title: "Tasks overdue",
        sql:
          "SELECT COUNT(*) AS value FROM crm_tasks WHERE status = 'open' AND due_at < :now " +
          "AND (:owner IS NULL OR assignee_id = :owner)",
        mapping: { value: "value" },
        options: { compare: false },
        clickThrough: {
          object: "task",
          filter: {
            and: [
              { field: "status", op: "eq", value: "open" },
              { field: "dueAt", op: "lt", value: { $param: "now" } },
              { field: "assigneeId", op: "eq", value: { $param: "owner" } },
            ],
          },
        },
        layout: { w: 3, h: 1 },
      },
      {
        id: "added-over-time",
        type: "line",
        title: "People and organisations added",
        sql: [
          "SELECT month, series, object, value,",
          "  month || '-01T00:00:00.000Z' AS bucket_start,",
          "  strftime('%Y-%m-%dT%H:%M:%fZ', month || '-01', '+1 month') AS bucket_end",
          "FROM (",
          "  SELECT substr(created_at, 1, 7) AS month, 'People' AS series, 'person' AS object,",
          "    COUNT(*) AS value",
          `  FROM crm_people WHERE ${IN_RANGE} AND ${OWNER}`,
          "  GROUP BY substr(created_at, 1, 7)",
          "  UNION ALL",
          "  SELECT substr(created_at, 1, 7), 'Organisations', 'organisation', COUNT(*)",
          `  FROM crm_organisations WHERE ${IN_RANGE} AND ${OWNER}`,
          "  GROUP BY substr(created_at, 1, 7)",
          ")",
          "ORDER BY month, series",
        ].join("\n"),
        mapping: { x: "month", y: "value", series: "series" },
        options: { area: true },
        clickThrough: {
          object: "person",
          objectColumn: "object",
          filter: {
            and: [
              ...createdInRange().and,
              { field: "createdAt", op: "gte", value: { $row: "bucket_start" } },
              { field: "createdAt", op: "lt", value: { $row: "bucket_end" } },
            ],
          },
        },
        layout: { w: 8, h: 3 },
      },
      {
        id: "activities-by-type",
        type: "donut",
        title: "Activities by type",
        sql:
          "SELECT type AS label, COUNT(*) AS value FROM crm_activities " +
          "WHERE occurred_at >= :date_from AND occurred_at < :date_to " +
          "AND type <> 'system' " +
          "AND (:owner IS NULL OR author_user_id = :owner) " +
          "GROUP BY type ORDER BY value DESC, label",
        mapping: { label: "label", value: "value" },
        options: {},
        clickThrough: {
          object: "activity",
          filter: {
            and: [
              { field: "type", op: "eq", value: { $row: "label" } },
              { field: "occurredAt", op: "gte", value: { $param: "date_from" } },
              { field: "occurredAt", op: "lt", value: { $param: "date_to" } },
              { field: "authorUserId", op: "eq", value: { $param: "owner" } },
            ],
          },
        },
        layout: { w: 4, h: 3 },
      },
      {
        id: "tasks-due",
        type: "bar",
        title: "Open tasks by due date",
        sql: [
          `SELECT 'Overdue' AS label, COUNT(*) AS value, ${MIN} AS due_from, :now AS due_to`,
          "FROM crm_tasks WHERE status = 'open' AND due_at < :now",
          "  AND (:owner IS NULL OR assignee_id = :owner)",
          "UNION ALL",
          `SELECT 'Next 7 days', COUNT(*), :now, ${WEEK}`,
          `FROM crm_tasks WHERE status = 'open' AND due_at >= :now AND due_at < ${WEEK}`,
          "  AND (:owner IS NULL OR assignee_id = :owner)",
          "UNION ALL",
          `SELECT 'Later', COUNT(*), ${WEEK}, ${MAX}`,
          `FROM crm_tasks WHERE status = 'open' AND due_at >= ${WEEK}`,
          "  AND (:owner IS NULL OR assignee_id = :owner)",
        ].join("\n"),
        mapping: { x: "label", y: "value" },
        options: { orientation: "vertical" },
        clickThrough: {
          object: "task",
          filter: {
            and: [
              { field: "status", op: "eq", value: "open" },
              { field: "dueAt", op: "gte", value: { $row: "due_from" } },
              { field: "dueAt", op: "lt", value: { $row: "due_to" } },
              { field: "assigneeId", op: "eq", value: { $param: "owner" } },
            ],
          },
        },
        layout: { w: 4, h: 3 },
      },
      {
        id: "top-owners",
        type: "leaderboard",
        title: "Top owners by people added",
        sql: [
          "SELECT p.owner_id AS owner_id, u.name AS label, COUNT(*) AS value",
          "FROM crm_people p JOIN crm_users u ON u.id = p.owner_id",
          "WHERE p.created_at >= :date_from AND p.created_at < :date_to",
          "  AND (:owner IS NULL OR p.owner_id = :owner)",
          "GROUP BY p.owner_id, u.name",
          "ORDER BY value DESC, label",
        ].join("\n"),
        mapping: { label: "label", value: "value" },
        options: { limit: 10 },
        clickThrough: {
          object: "person",
          filter: {
            and: [
              ...createdInRange(false).and,
              { field: "ownerId", op: "eq", value: { $row: "owner_id" } },
            ],
          },
        },
        layout: { w: 4, h: 3 },
      },
      {
        id: "tasks-due-soon",
        type: "table",
        title: "Open tasks due soonest",
        sql: [
          "SELECT t.id AS id, t.title AS title, t.due_at AS due, u.name AS assignee",
          "FROM crm_tasks t LEFT JOIN crm_users u ON u.id = t.assignee_id",
          "WHERE t.status = 'open' AND t.due_at >= " + MIN,
          "  AND (:owner IS NULL OR t.assignee_id = :owner)",
          "ORDER BY t.due_at, t.id",
        ].join("\n"),
        mapping: { columns: ["title", "due", "assignee"] },
        options: { limit: 10 },
        clickThrough: {
          object: "task",
          filter: { field: "id", op: "eq", value: { $row: "id" } },
        },
        layout: { w: 8, h: 3 },
      },
      {
        id: "about",
        type: "markdown",
        title: "About this dashboard",
        markdown:
          "Counts follow the **Date** and **Owner** filters (tasks follow Owner only). Click a " +
          "number, bar, segment or row to open the matching records. Copy this dashboard to " +
          "make your own, or set any dashboard as your Home.",
        mapping: {},
        options: {},
        layout: { w: 4, h: 3 },
      },
    ],
  },
};
