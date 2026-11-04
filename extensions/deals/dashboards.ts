// The Deals dashboards (stage 4b): Sales overview (the default Home once Deals is installed) and
// Pipeline health. Each widget is read-only SQL over the crm_* views with named params bound
// from the dashboard's filters (ADR 0057), and a click-through that opens exactly the deals it
// counted (tested per widget in packages/core/test/deals-dashboards.test.ts). Every query walks
// one of the deal indexes declared in index.ts.
import type { DashboardDeclaration } from "@crm/sdk";

const OWNER = "(:owner IS NULL OR d.owner = :owner)";
const CLOSED_IN_RANGE = "d.closed_at >= :date_from AND d.closed_at < :date_to";
const ownerFilter = { field: "owner", op: "eq" as const, value: { $param: "owner" } };
const closedInRange = (status: "won" | "lost") => ({
  and: [
    { field: "status", op: "eq" as const, value: status },
    { field: "closedAt", op: "gte" as const, value: { $param: "date_from" } },
    { field: "closedAt", op: "lt" as const, value: { $param: "date_to" } },
    ownerFilter,
  ],
});

const FILTERS = [
  { type: "dateRange" as const, id: "date", label: "Closed", default: "this_quarter" as const },
  { type: "user" as const, id: "owner", label: "Owner", default: "anyone" as const },
];

export const salesOverview: DashboardDeclaration = {
  title: "Sales overview",
  description: "Open pipeline, forecast, wins and win rate across your deals.",
  home: true,
  filters: FILTERS,
  widgets: [
    {
      id: "won",
      type: "kpi",
      title: "Won",
      description: "Value of deals won in the period, against the previous period.",
      sql: `SELECT coalesce(sum(d.value), 0) AS value, count(*) AS deals FROM crm_x_deals_deal d WHERE d.status = 'won' AND ${CLOSED_IN_RANGE} AND ${OWNER}`,
      mapping: { value: "value" },
      options: { format: "currency", compare: true },
      clickThrough: { object: "deals.deal", filter: closedInRange("won") },
      layout: { w: 3, h: 1 },
    },
    {
      id: "win-rate",
      type: "kpi",
      title: "Win rate",
      description: "Deals won out of deals closed (won or lost) in the period.",
      sql: `SELECT CASE WHEN count(*) = 0 THEN NULL ELSE round(100.0 * sum(d.status = 'won') / count(*), 1) END AS value, count(*) AS deals FROM crm_x_deals_deal d WHERE d.status IN ('won', 'lost') AND ${CLOSED_IN_RANGE} AND ${OWNER}`,
      mapping: { value: "value" },
      options: { format: "percent", compare: true },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "in", value: ["won", "lost"] },
            { field: "closedAt", op: "gte", value: { $param: "date_from" } },
            { field: "closedAt", op: "lt", value: { $param: "date_to" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "average-deal",
      type: "kpi",
      title: "Average deal size",
      description: "Average value of deals won in the period.",
      sql: `SELECT round(avg(d.value), 2) AS value, count(*) AS deals FROM crm_x_deals_deal d WHERE d.status = 'won' AND ${CLOSED_IN_RANGE} AND ${OWNER}`,
      mapping: { value: "value" },
      options: { format: "currency", compare: true },
      clickThrough: { object: "deals.deal", filter: closedInRange("won") },
      layout: { w: 3, h: 1 },
    },
    {
      id: "open-pipeline",
      type: "kpi",
      title: "Open pipeline",
      description: "Value of all open deals (not limited to the period).",
      sql: `SELECT coalesce(sum(d.value), 0) AS value, count(*) AS deals FROM crm_x_deals_deal d WHERE d.status = 'open' AND ${OWNER}`,
      mapping: { value: "value" },
      options: { format: "currency", compare: false },
      clickThrough: {
        object: "deals.deal",
        filter: { and: [{ field: "status", op: "eq", value: "open" }, ownerFilter] },
      },
      layout: { w: 3, h: 1 },
    },
    {
      id: "pipeline-by-stage",
      type: "bar",
      title: "Open pipeline by stage",
      sql: [
        "SELECT s.id AS stage_id, p.name || ': ' || s.name AS label, count(*) AS deals,",
        "  coalesce(sum(d.value), 0) AS value",
        "FROM crm_x_deals_deal d",
        "JOIN crm_x_deals_stage s ON s.id = d.stage",
        "JOIN crm_x_deals_pipeline p ON p.id = s.pipeline",
        `WHERE d.status = 'open' AND ${OWNER}`,
        "GROUP BY s.id, p.name, s.name, p.position, s.position",
        "ORDER BY p.position, p.name, s.position",
      ].join("\n"),
      mapping: { x: "label", y: "value" },
      options: { orientation: "horizontal", format: "currency" },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "open" },
            { field: "stage", op: "eq", value: { $row: "stage_id" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "weighted-forecast",
      type: "bar",
      title: "Weighted forecast by close month",
      description: "Open deals by expected close month: value × probability.",
      sql: [
        "SELECT month, round(sum(weighted), 2) AS weighted, count(*) AS deals,",
        "  month || '-01' AS month_start, date(month || '-01', '+1 month') AS month_end",
        "FROM (",
        "  SELECT substr(d.expected_close, 1, 7) AS month,",
        "    coalesce(d.value, 0) * coalesce(d.probability, 0) / 100.0 AS weighted",
        "  FROM crm_x_deals_deal d",
        `  WHERE d.status = 'open' AND d.expected_close >= '0000-01-01' AND ${OWNER}`,
        ")",
        "GROUP BY month ORDER BY month",
      ].join("\n"),
      mapping: { x: "month", y: "weighted" },
      options: { format: "currency" },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "open" },
            { field: "expectedClose", op: "gte", value: { $row: "month_start" } },
            { field: "expectedClose", op: "lt", value: { $row: "month_end" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "deals-by-owner",
      type: "leaderboard",
      title: "Open pipeline by owner",
      sql: [
        "SELECT d.owner AS owner_id, u.name AS label, coalesce(sum(d.value), 0) AS value,",
        "  count(*) AS deals",
        "FROM crm_x_deals_deal d JOIN crm_users u ON u.id = d.owner",
        `WHERE d.status = 'open' AND ${OWNER}`,
        "GROUP BY d.owner, u.name ORDER BY value DESC, label",
      ].join("\n"),
      mapping: { label: "label", value: "value" },
      options: { format: "currency", limit: 10 },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "open" },
            { field: "owner", op: "eq", value: { $row: "owner_id" } },
          ],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "won-by-month",
      type: "bar",
      title: "Won by month",
      sql: [
        "SELECT month, coalesce(sum(value), 0) AS value, count(*) AS deals,",
        "  month || '-01T00:00:00.000Z' AS month_start,",
        "  strftime('%Y-%m-%dT%H:%M:%fZ', month || '-01', '+1 month') AS month_end",
        "FROM (",
        "  SELECT substr(d.closed_at, 1, 7) AS month, d.value AS value",
        "  FROM crm_x_deals_deal d",
        `  WHERE d.status = 'won' AND ${CLOSED_IN_RANGE} AND ${OWNER}`,
        ")",
        "GROUP BY month ORDER BY month",
      ].join("\n"),
      mapping: { x: "month", y: "value" },
      options: { format: "currency" },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            ...closedInRange("won").and,
            { field: "closedAt", op: "gte", value: { $row: "month_start" } },
            { field: "closedAt", op: "lt", value: { $row: "month_end" } },
          ],
        },
      },
      layout: { w: 6, h: 3 },
    },
  ],
};

export const pipelineHealth: DashboardDeclaration = {
  title: "Pipeline health",
  description: "Stalled deals, slipped close dates and how long deals sit in each stage.",
  filters: [FILTERS[1] as (typeof FILTERS)[1]],
  widgets: [
    {
      id: "slipped",
      type: "kpi",
      title: "Slipped close dates",
      description: "Open deals whose expected close date has passed.",
      sql: `SELECT count(*) AS value, count(*) AS deals FROM crm_x_deals_deal d WHERE d.status = 'open' AND d.expected_close < :today AND ${OWNER}`,
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "open" },
            { field: "expectedClose", op: "lt", value: { $param: "today" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 6, h: 1 },
    },
    {
      id: "slipped-value",
      type: "kpi",
      title: "Value at risk",
      description: "Value of open deals whose expected close date has passed.",
      sql: `SELECT coalesce(sum(d.value), 0) AS value, count(*) AS deals FROM crm_x_deals_deal d WHERE d.status = 'open' AND d.expected_close < :today AND ${OWNER}`,
      mapping: { value: "value" },
      options: { format: "currency", compare: false },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "open" },
            { field: "expectedClose", op: "lt", value: { $param: "today" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 6, h: 1 },
    },
    {
      id: "time-in-stage",
      type: "bar",
      title: "Days in current stage (open deals)",
      sql: [
        "SELECT s.id AS stage_id, p.name || ': ' || s.name AS label,",
        "  round(avg(h.days_in_stage), 1) AS days, count(*) AS deals",
        "FROM crm_stage_history h",
        "JOIN crm_x_deals_deal d ON d.id = h.record_id AND d.stage = h.stage_id",
        "JOIN crm_x_deals_stage s ON s.id = h.stage_id",
        "JOIN crm_x_deals_pipeline p ON p.id = s.pipeline",
        `WHERE h.object_type = 'deals.deal' AND h.left_at IS NULL AND d.status = 'open' AND ${OWNER}`,
        "GROUP BY s.id, p.name, s.name, p.position, s.position",
        "ORDER BY p.position, p.name, s.position",
      ].join("\n"),
      mapping: { x: "label", y: "days" },
      options: { orientation: "horizontal" },
      clickThrough: {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "open" },
            { field: "stage", op: "eq", value: { $row: "stage_id" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "stalled",
      type: "table",
      title: "Stalled deals",
      description: "Open deals with no activity in 14 days, the longest quiet first.",
      sql: [
        "SELECT d.id AS id, d.name AS deal, s.name AS stage, d.value AS value,",
        "  d.expected_close AS expected_close, u.name AS owner",
        "FROM crm_x_deals_deal d",
        "JOIN crm_x_deals_stage s ON s.id = d.stage",
        "LEFT JOIN crm_users u ON u.id = d.owner",
        `WHERE d.status = 'open' AND ${OWNER}`,
        "  AND d.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', :now, '-14 days')",
        "  AND NOT EXISTS (",
        "    SELECT 1 FROM crm_activity_links l JOIN crm_activities a ON a.id = l.activity_id",
        "    WHERE l.object_type = 'deals.deal' AND l.record_id = d.id",
        "      AND a.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', :now, '-14 days'))",
        "  AND NOT EXISTS (",
        "    SELECT 1 FROM crm_stage_history h",
        "    WHERE h.object_type = 'deals.deal' AND h.record_id = d.id",
        "      AND h.entered_at >= strftime('%Y-%m-%dT%H:%M:%fZ', :now, '-14 days'))",
        "ORDER BY d.updated_at, d.id",
      ].join("\n"),
      mapping: { columns: ["deal", "stage", "value", "expected_close", "owner"] },
      options: { limit: 20 },
      clickThrough: {
        object: "deals.deal",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "slipped-list",
      type: "table",
      title: "Slipped close dates",
      sql: [
        "SELECT d.id AS id, d.name AS deal, d.expected_close AS expected_close, d.value AS value,",
        "  u.name AS owner",
        "FROM crm_x_deals_deal d LEFT JOIN crm_users u ON u.id = d.owner",
        `WHERE d.status = 'open' AND d.expected_close < :today AND ${OWNER}`,
        "ORDER BY d.expected_close, d.id",
      ].join("\n"),
      mapping: { columns: ["deal", "expected_close", "value", "owner"] },
      options: { limit: 20 },
      clickThrough: {
        object: "deals.deal",
        filter: { field: "id", op: "eq", value: { $row: "id" } },
      },
      layout: { w: 6, h: 3 },
    },
  ],
};
