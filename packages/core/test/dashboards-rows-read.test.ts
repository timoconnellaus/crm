// D1 cost of the Overview dashboard (ADR 0057, docs/research/cloudflare-cost-audit.md U4): every
// widget query walks an index (EXPLAIN QUERY PLAN shows no full table scan), and rows read stay
// within budgets on a seeded database, so the default Home never scans whole tables.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@crm/db";
import { seedDatabase } from "@crm/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  bindNamedParams,
  invokeByName,
  memoryWidgetCache,
  OVERVIEW_DASHBOARD,
  OVERVIEW_DASHBOARD_ID,
  resolveParams,
  widgetParamNames,
} from "../src/index.ts";
import { createUser } from "./helpers.ts";

const PEOPLE = 3000;
const ORGANISATIONS = 600;
const ACTIVITIES = 600;
const TASKS = 400;
let rowsRead = 0;

/** env.DB, counting meta.rows_read for every statement Kysely runs. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all") {
                return async () => {
                  const result = await s.all();
                  rowsRead += result.meta.rows_read;
                  return result;
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

let member: ActingUser;

// The seed's records were all created on 2025-01-01 and its tasks are due around then.
const NOW = new Date("2025-01-20T12:00:00.000Z");
const widgets = OVERVIEW_DASHBOARD.spec.widgets.filter((w) => w.type !== "markdown");

beforeAll(async () => {
  member = await createUser("member");
  await seedDatabase(env.DB, {
    people: PEOPLE,
    organisations: ORGANISATIONS,
    activities: ACTIVITIES,
    tasks: TASKS,
  });
}, 120_000);

async function run(widgetId: string, filters: Record<string, unknown>): Promise<number> {
  // Warm the schema-name memo so only the widget's own query is counted.
  await invokeByName(
    "widget.run",
    { dashboardId: OVERVIEW_DASHBOARD_ID, widgetId: "tasks-overdue" },
    { actor: "human", user: member, origin: { surface: "ui" }, db, clock: () => NOW },
  );
  rowsRead = 0;
  await invokeByName(
    "widget.run",
    { dashboardId: OVERVIEW_DASHBOARD_ID, widgetId, filters, refresh: true },
    {
      actor: "human",
      user: member,
      origin: { surface: "ui" },
      db,
      clock: () => NOW,
      widgetCache: memoryWidgetCache(),
    },
  );
  return rowsRead;
}

/** The SQLite plan of a widget's query, as text lines. */
async function plan(sql: string): Promise<string[]> {
  const resolved = resolveParams({
    filters: OVERVIEW_DASHBOARD.spec.filters,
    values: {},
    now: NOW,
    userId: member.id,
  });
  const bound = bindNamedParams(
    sql,
    resolved.values,
    widgetParamNames(OVERVIEW_DASHBOARD.spec.filters),
  );
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${bound.sql}`)
    .bind(...bound.params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

describe("Overview dashboard cost", () => {
  it.each(widgets.map((w) => [w.id, w.sql as string]))(
    "%s walks an index, never a full scan of a core table",
    async (_id, sql) => {
      const lines = await plan(sql);
      const fullScans = lines.filter(
        (line) =>
          /^SCAN (core_|person|organisation|activity|task)/.test(line) &&
          !/USING (COVERING )?INDEX/.test(line),
      );
      expect(fullScans, lines.join("\n")).toEqual([]);
    },
  );

  it("reads only the rows in the default 90-day window", async () => {
    // NOW is 19 days after the seed, so every seeded record is in the window: the budgets are
    // the matching rows, times the rows each match visits (index entry, row, and the crm_*
    // view's primary-affiliation and organisation joins for people), never the table again.
    const budgets: Record<string, number> = {
      "people-added": PEOPLE * 3.2,
      "organisations-added": ORGANISATIONS * 3.2,
      "activities-logged": ACTIVITIES * 2.2,
      "tasks-overdue": TASKS * 2.2,
      "added-over-time": (PEOPLE + ORGANISATIONS) * 4, // plus the GROUP BY sorter
      "activities-by-type": ACTIVITIES * 2.2,
      "tasks-due": TASKS * 2.2 + 50,
      "top-owners": PEOPLE * 3.2,
      "tasks-due-soon": 200,
    };
    for (const widget of widgets) {
      const read = await run(widget.id, {});
      expect(read, widget.id).toBeLessThan(budgets[widget.id] ?? 0);
    }
  });

  it("a narrow date window reads only what is in it", async () => {
    // A window before every seeded record: the index range is empty.
    const filters = { date: { from: "2024-06-01", to: "2024-06-30" } };
    for (const id of [
      "people-added",
      "organisations-added",
      "activities-logged",
      "added-over-time",
      "activities-by-type",
      "top-owners",
    ]) {
      expect(await run(id, filters), id).toBeLessThan(20);
    }
  });
});
