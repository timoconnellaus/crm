// The saved A2UI producers this deployment can run (ADR 0346). First-party ones are here; plugins
// (W7) register theirs in `producers` when they install. A version's source never changes: edit a
// script, bump its version, and it gets a new stable worker id.
import { createProducerRegistry, type SavedProducer } from "@relationship-os/agent-a2ui";
import { z } from "zod";

const OVERDUE_TASKS = `
export default async function (input, { crm, timezone }) {
  const mine = await crm.call("task.listMine", { timezone });
  const overdue = mine.buckets.overdue;
  if (!overdue.length) {
    return {
      a2ui: 1,
      root: {
        type: "emptyState",
        title: "Nothing overdue",
        text: "You are up to date with your tasks.",
        action: { kind: "open", label: "Open Tasks", href: "/tasks" },
      },
    };
  }
  const day = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone, weekday: "short", day: "numeric", month: "short",
  });
  const tasks = overdue.slice(0, input.limit).map((task) => {
    const link = task.links[0];
    return {
      id: task.id,
      title: task.title.slice(0, 300),
      overdue: true,
      ...(task.dueAt
        ? { dueAt: task.dueAt, dueLabel: "Due " + day.format(new Date(task.dueAt)) }
        : {}),
      ...(link && link.title
        ? { record: { object: link.object, id: link.id, label: link.title.slice(0, 200) } }
        : {}),
    };
  });
  return {
    a2ui: 1,
    root: { type: "taskList", title: "Overdue tasks", tasks, total: overdue.length, viewAll: "/tasks" },
  };
}
`;

const STALE_DEALS = `
const SQL = \`
WITH last AS (
  SELECT l.record_id AS id, max(a.occurred_at) AS at
  FROM crm_activity_links l JOIN crm_activities a ON a.id = l.activity_id
  WHERE l.object_type = 'deals.deal' GROUP BY l.record_id
)
SELECT d.id AS id, d.name AS name, d.value AS value, s.name AS stage,
  coalesce(last.at, d.updated_at) AS last_at
FROM crm_x_deals_deal d
JOIN crm_x_deals_stage s ON s.id = d.stage
LEFT JOIN last ON last.id = d.id
WHERE d.status = 'open' AND coalesce(last.at, d.updated_at) < ?
ORDER BY last_at
\`;

export default async function (input, { crm, now }) {
  const nowMs = new Date(now).getTime();
  const cutoff = new Date(nowMs - input.days * 86400000).toISOString();
  const result = await crm.call("query.sql", { sql: SQL, params: [cutoff], maxRows: 200 });
  const rows = result.rows;
  if (!rows.length) {
    return {
      a2ui: 1,
      root: {
        type: "emptyState",
        title: "No quiet deals",
        text: "Every open deal has had activity in the last " + input.days + " days.",
        action: { kind: "open", label: "Open deals", href: "/x/deals.deal" },
      },
    };
  }
  const amount = (value) =>
    typeof value === "number" ? new Intl.NumberFormat("en").format(value) : undefined;
  const total = rows.reduce((sum, row) => sum + (typeof row.value === "number" ? row.value : 0), 0);
  const deals = rows.slice(0, input.limit).map((row) => {
    const days = Math.floor((nowMs - new Date(row.last_at).getTime()) / 86400000);
    const value = amount(row.value);
    return {
      deal: { object: "deals.deal", id: row.id, label: String(row.name).slice(0, 200) },
      detail: row.stage + " · " + days + " days since activity",
      ...(value ? { value } : {}),
    };
  });
  const count = rows.length + (result.truncated ? "+" : "");
  return {
    a2ui: 1,
    root: {
      type: "dealList",
      title: "Quiet for " + input.days + "+ days",
      summary: count + (rows.length === 1 ? " deal" : " deals") + " · " + amount(total),
      deals,
      actions: [
        { kind: "reply", label: "Create follow-up tasks", text: "Create a follow-up task for each of these deals" },
        { kind: "open", label: "View all", href: "/x/deals.deal" },
      ],
    },
  };
}
`;

const limit = z.number().int().min(1).max(20).default(20);

/** Shipped with the app. */
export const FIRST_PARTY_PRODUCERS: readonly SavedProducer[] = [
  {
    name: "tasks.overdueCard",
    version: 1,
    catalogue: 1,
    description: "Your overdue tasks with Complete and Snooze. Input: { limit? }",
    input: z.object({ limit }),
    source: OVERDUE_TASKS,
  },
  {
    name: "pipeline.staleDealsCard",
    version: 1,
    catalogue: 1,
    description: "Open deals with no activity for some days. Input: { days? (14), limit? }",
    input: z.object({ days: z.number().int().min(1).max(365).default(14), limit }),
    source: STALE_DEALS,
  },
];

/** The registry `a2ui.produce` runs from. W7's plugin install registers into it. */
export const producers = createProducerRegistry(FIRST_PARTY_PRODUCERS);
