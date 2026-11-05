// "Describe a widget" (ADR 0059): a prompt plus the schema goes to the `build` model role, which
// answers with a widget spec (type, SQL, chart mapping, click-through). The answer is parsed,
// validated by the same guards as saved widgets, and previewed; one failed attempt is sent back
// to the model with the error, so it can fix its SQL. Nothing is saved here.
import { listObjects } from "../fields/index.ts";
import type { ModelMessage, ModelRunner } from "../models.ts";
import { allowedParamNames, type DashboardFilter, SYSTEM_PARAMS, WIDGET_TYPES } from "./spec.ts";

/** The crm_* views a widget may read, with their columns, for the model prompt. */
export function schemaSummary(): string {
  const lines: string[] = [];
  for (const object of listObjects()) {
    const columns = object.fields
      .filter((f) => f.column)
      .map(
        (f) =>
          `${f.column} (${f.fieldType ?? f.type}${f.enumValues ? `: ${f.enumValues.join("|")}` : ""})`,
      );
    lines.push(`${object.source} -- ${object.label} records: ${columns.join(", ")}`);
  }
  lines.push(
    "crm_users -- people who sign in: id, name, email, role",
    "crm_affiliations -- person ↔ organisation links: id, person_id, organisation_id, title, is_current, is_primary",
    "crm_activity_links -- activity ↔ record links: activity_id, object_type, record_id",
    "crm_task_links -- task ↔ record links: task_id, object_type, record_id",
    "crm_record_tags -- tags: object_type, record_id, name",
  );
  return lines.join("\n");
}

export function describePrompt(
  prompt: string,
  filters: readonly DashboardFilter[],
): ModelMessage[] {
  const params = allowedParamNames(filters);
  const system = [
    "You write one dashboard widget for a CRM as a single JSON object, and nothing else.",
    `Widget types: ${WIDGET_TYPES.join(", ")}.`,
    "Shape: {",
    '  "id": "kebab-case-id", "type": "...", "title": "Short title",',
    '  "sql": "one read-only SQLite SELECT over the crm_* views below",',
    '  "mapping": { "x": col, "y": col, "series": col, "label": col, "value": col, "columns": [cols] },',
    '  "options": { "orientation": "vertical|horizontal", "area": bool, "pie": bool, "limit": n },',
    '  "clickThrough": { "object": "person|organisation|activity|task|<ext>.<object>", "filter": <filter JSON> }',
    "}",
    "Mapping by type: kpi → value (one row; COUNT/SUM AS value). bar/line → x and y (optionally",
    "series for a long-format second dimension). donut/funnel → label and value. leaderboard →",
    "label and value, ordered by value DESC. table → columns. markdown → markdown text, no sql.",
    `Named SQL parameters you may use: ${params.map((p) => `:${p}`).join(", ")}.`,
    `System parameters: ${Object.entries(SYSTEM_PARAMS)
      .map(([k, v]) => `:${k} = ${v}`)
      .join("; ")}.`,
    filters.some((f) => f.type === "dateRange")
      ? "Date range parameters are ISO-8601 strings: filter with `created_at >= :date_from AND created_at < :date_to` (never wrap the column in a function)."
      : "",
    filters.some((f) => f.type === "user")
      ? "The owner parameter may be null: write `(:owner IS NULL OR owner_id = :owner)`."
      : "",
    "Rules: SELECT or WITH only; no positional ? parameters; quote aliases that are SQL keywords;",
    "timestamps are ISO-8601 text (group months with substr(created_at, 1, 7)); multi-valued",
    "columns (emails, tags) are JSON arrays. Prefer COUNT(*) AS value. Keep it fast: filter on",
    "created_at, occurred_at, due_at or status.",
    "clickThrough.filter uses { field, op, value } with registry field names (camelCase, e.g.",
    'createdAt, ownerId, status, dueAt, type, occurredAt) and placeholders { "$row": "<column>" } or',
    '{ "$param": "<name>" } for values from the clicked row or the bound parameters.',
    "",
    "Views:",
    schemaSummary(),
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: prompt.slice(0, 4000) },
  ];
}

/** The first JSON object in a model answer (fenced or bare), or null. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  // Scan for the matching close brace, honouring strings.
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1)) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// --- The local stand-in for the build role ----------------------------------------------------

interface FakeWidget {
  match: RegExp;
  widget: Record<string, unknown>;
}

const FAKE_WIDGETS: FakeWidget[] = [
  {
    match: /task.*status|status.*task/i,
    widget: {
      id: "tasks-by-status",
      type: "bar",
      title: "Tasks by status",
      sql: "SELECT status AS label, COUNT(*) AS value FROM crm_tasks GROUP BY status ORDER BY status",
      mapping: { x: "label", y: "value" },
      clickThrough: {
        object: "task",
        filter: { field: "status", op: "eq", value: { $row: "label" } },
      },
    },
  },
  {
    match: /activit/i,
    widget: {
      id: "activities-by-type",
      type: "donut",
      title: "Activities by type",
      sql:
        "SELECT type AS label, COUNT(*) AS value FROM crm_activities " +
        "WHERE occurred_at >= :date_from AND occurred_at < :date_to GROUP BY type ORDER BY value DESC",
      mapping: { label: "label", value: "value" },
      clickThrough: {
        object: "activity",
        filter: { field: "type", op: "eq", value: { $row: "label" } },
      },
    },
  },
  {
    match: /organi[sz]ation/i,
    widget: {
      id: "organisations-by-industry",
      type: "bar",
      title: "Organisations by industry",
      sql:
        "SELECT coalesce(industry, 'Unknown') AS label, COUNT(*) AS value FROM crm_organisations " +
        "GROUP BY industry ORDER BY value DESC",
      mapping: { x: "label", y: "value" },
      options: { orientation: "horizontal" },
    },
  },
  {
    match: /month|over time|trend/i,
    widget: {
      id: "people-by-month",
      type: "line",
      title: "People added by month",
      sql:
        "SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS value FROM crm_people " +
        "WHERE created_at >= :date_from AND created_at < :date_to GROUP BY month ORDER BY month",
      mapping: { x: "month", y: "value" },
    },
  },
];

const FAKE_DEFAULT: Record<string, unknown> = {
  id: "people-count",
  type: "kpi",
  title: "People",
  sql: "SELECT COUNT(*) AS value FROM crm_people",
  mapping: { value: "value" },
  clickThrough: { object: "person" },
};

/** The canned widget the stand-ins pick for a prompt (also used by the scripted assistant). */
export function fakeWidget(prompt: string): Record<string, unknown> {
  return FAKE_WIDGETS.find((w) => w.match.test(prompt))?.widget ?? FAKE_DEFAULT;
}

/**
 * A deterministic stand-in for the build role, for local development and e2e tests without an
 * AI binding (`AI_FAKE_MODEL=true`). It picks a canned widget by keywords in the prompt and
 * answers in the same JSON shape a real model is asked for.
 */
export function fakeBuildModel(): ModelRunner {
  return {
    async run(_role, messages) {
      const prompt = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const widget = fakeWidget(prompt);
      return { text: `\`\`\`json\n${JSON.stringify(widget, null, 2)}\n\`\`\``, model: "fake" };
    },
  };
}
