// The Leads dashboard (stage 15): counts only, no scores. Leads by status, by source and by owner,
// leads created per week, and conversions this month. Each widget is read-only SQL over
// crm_x_leads_lead with named params bound from the filters (ADR 0057), and a click-through that
// opens the leads it counted.
import type { DashboardDeclaration } from "@relationship-os/sdk";

const OWNER = "(:owner IS NULL OR l.owner = :owner)";
const CREATED = "l.created_at >= :created_from AND l.created_at < :created_to";
const ownerFilter = { field: "owner", op: "eq" as const, value: { $param: "owner" } };
const createdInRange = [
  { field: "createdAt", op: "gte" as const, value: { $param: "created_from" } },
  { field: "createdAt", op: "lt" as const, value: { $param: "created_to" } },
  ownerFilter,
];

export const leadsDashboard: DashboardDeclaration = {
  title: "Leads",
  description: "New leads, where they come from, who has them, and how many became deals.",
  filters: [
    { type: "dateRange", id: "created", label: "Created", default: "this_quarter" },
    { type: "user", id: "owner", label: "Owner", default: "anyone" },
  ],
  widgets: [
    {
      id: "created",
      type: "kpi",
      title: "Leads created",
      description: "Leads created in the period, against the previous period.",
      sql: `SELECT count(*) AS value FROM crm_x_leads_lead l WHERE ${CREATED} AND ${OWNER}`,
      mapping: { value: "value" },
      options: { compare: true },
      clickThrough: { object: "leads.lead", filter: { and: createdInRange } },
      layout: { w: 4, h: 1 },
    },
    {
      id: "open",
      type: "kpi",
      title: "In the inbox",
      description: "Leads that are new or contacted (not limited to the period).",
      sql: `SELECT count(*) AS value FROM crm_x_leads_lead l WHERE l.status IN ('new', 'contacted') AND ${OWNER}`,
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "leads.lead",
        filter: {
          and: [{ field: "status", op: "in", value: ["new", "contacted"] }, ownerFilter],
        },
      },
      layout: { w: 4, h: 1 },
    },
    {
      id: "converted-this-month",
      type: "kpi",
      title: "Converted this month",
      description: "Leads converted into deals since the start of this month.",
      sql: [
        "SELECT count(*) AS value, strftime('%Y-%m-01', :today) AS month_start",
        "FROM crm_x_leads_lead l",
        `WHERE l.status = 'converted' AND l.converted_at >= strftime('%Y-%m-01', :today) AND ${OWNER}`,
      ].join("\n"),
      mapping: { value: "value" },
      options: { compare: false },
      clickThrough: {
        object: "leads.lead",
        filter: {
          and: [
            { field: "status", op: "eq", value: "converted" },
            { field: "convertedAt", op: "gte", value: { $row: "month_start" } },
            ownerFilter,
          ],
        },
      },
      layout: { w: 4, h: 1 },
    },
    {
      id: "by-status",
      type: "bar",
      title: "Leads by status",
      description: "Leads created in the period, by their status now.",
      sql: [
        "SELECT coalesce(l.status, '') AS status, count(*) AS leads",
        "FROM crm_x_leads_lead l",
        `WHERE ${CREATED} AND ${OWNER}`,
        "GROUP BY l.status ORDER BY leads DESC, status",
      ].join("\n"),
      mapping: { x: "status", y: "leads" },
      clickThrough: {
        object: "leads.lead",
        filter: {
          and: [...createdInRange, { field: "status", op: "eq", value: { $row: "status" } }],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "by-source",
      type: "donut",
      title: "Leads by source",
      sql: [
        "SELECT coalesce(l.source, '') AS source, count(*) AS leads",
        "FROM crm_x_leads_lead l",
        `WHERE ${CREATED} AND ${OWNER}`,
        "GROUP BY l.source ORDER BY leads DESC, source",
      ].join("\n"),
      mapping: { label: "source", value: "leads" },
      clickThrough: {
        object: "leads.lead",
        filter: {
          and: [...createdInRange, { field: "source", op: "eq", value: { $row: "source" } }],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "by-owner",
      type: "bar",
      title: "Leads by owner",
      description: "Leads created in the period, by owner (unassigned ones under No owner).",
      sql: [
        "SELECT coalesce(l.owner, '') AS owner_id, coalesce(u.name, 'No owner') AS owner,",
        "  count(*) AS leads",
        "FROM crm_x_leads_lead l LEFT JOIN crm_users u ON u.id = l.owner",
        `WHERE ${CREATED} AND ${OWNER}`,
        "GROUP BY l.owner, u.name ORDER BY leads DESC, owner",
      ].join("\n"),
      mapping: { x: "owner", y: "leads" },
      options: { orientation: "horizontal" },
      clickThrough: {
        object: "leads.lead",
        filter: {
          and: [...createdInRange, { field: "owner", op: "eq", value: { $row: "owner_id" } }],
        },
      },
      layout: { w: 6, h: 3 },
    },
    {
      id: "per-week",
      type: "line",
      title: "Leads created per week",
      sql: [
        "SELECT date(l.created_at, '-6 days', 'weekday 1') AS week, count(*) AS leads",
        "FROM crm_x_leads_lead l",
        `WHERE ${CREATED} AND ${OWNER}`,
        "GROUP BY week ORDER BY week",
      ].join("\n"),
      mapping: { x: "week", y: "leads" },
      layout: { w: 6, h: 3 },
    },
  ],
};
