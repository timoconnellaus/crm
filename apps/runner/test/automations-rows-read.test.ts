// The automation runtime's queries keep to their indexes (ADR 0130, cost audit U3): rows read
// budgets and EXPLAIN QUERY PLAN for trigger matching, run history (by automation and by record),
// the rate counters, the date-relative scan and the retention purge. Pattern: packages/core
// test/retention.test.ts.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  invokeByName,
  loadEnabledAutomations,
  purgeAutomationRuns,
  recordsOnDate,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_FILES, FIXTURE_ID, ITEM } from "./automation-fixture.ts";
import { call, context, createAdmin, install } from "./helpers.ts";

let rowsRead = 0;
let recorded: { sql: string; params: unknown[] }[] = [];

const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement, params: unknown[]): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), args);
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  recorded.push({ sql: query, params });
                  const result = await s.all();
                  rowsRead += result.meta.rows_read;
                  if (p === "first") {
                    const row = result.results[0] as Record<string, unknown> | undefined;
                    const col = args[0] as string | undefined;
                    return col ? (row?.[col] ?? null) : (row ?? null);
                  }
                  if (p === "raw") return result.results.map((r) => Object.values(r as object));
                  return result;
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query), []);
      };
    }
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch(statements);
        for (const r of results) rowsRead += r.meta.rows_read;
        return results;
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const meteredDb = createCrmDb(metered);

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; rows: number }> {
  rowsRead = 0;
  recorded = [];
  const result = await fn();
  return { result, rows: rowsRead };
}

/** Full scans of `tables` in the recorded statements' plans (searches through an index are fine). */
async function scans(tables: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const { sql, params } of recorded) {
    if (!/^\s*(SELECT|DELETE|UPDATE|WITH)/i.test(sql)) continue;
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    for (const { detail } of plan.results) {
      for (const table of tables) {
        if (new RegExp(`^SCAN ${table}\\b`).test(detail) && !/USING .*INDEX/.test(detail)) {
          found.push(`${detail} ← ${sql.slice(0, 120)}`);
        }
      }
    }
  }
  return found;
}

let admin: ActingUser;
const AUTOMATION = `${FIXTURE_ID}.onCreate`;

beforeAll(async () => {
  admin = await createAdmin();
  await install(admin, FIXTURE_ID, FIXTURE_FILES);
  // Run history for many automations, so an unindexed read would show.
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < 600; i++) {
    const at = new Date(now - i * 60_000).toISOString();
    const automation = i % 6 === 0 ? AUTOMATION : `other.a${i % 5}`;
    statements.push(
      env.DB.prepare(
        "INSERT INTO core_automation_runs (id, automation_id, extension_id, workflow_id, trigger, record_object, record_id, status, root_event_id, started_at, updated_at) VALUES (?, ?, 'x', ?, '{}', 'autot.item', ?, ?, ?, ?, ?)",
      ).bind(
        `arn_${String(i).padStart(26, "0")}`,
        automation,
        `run-${i}`,
        `rec_${i % 50}`,
        i % 3 ? "completed" : "failed",
        `aud_${i % 10}`,
        at,
        at,
      ),
      env.DB.prepare(
        "INSERT INTO core_automation_run_records (object_type, record_id, run_id, role, at) VALUES ('autot.item', ?, ?, 'trigger', ?)",
      ).bind(`rec_${i % 50}`, `arn_${String(i).padStart(26, "0")}`, at),
    );
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
  for (let i = 0; i < 60; i++) {
    await call(admin, "record.create", {
      object: ITEM,
      values: { name: `D${i}`, level: 1, due: `2027-0${1 + (i % 6)}-1${i % 10}` },
    });
  }
});

describe("rows read and query plans", () => {
  it("trigger matching reads the enabled automations of the event's objects only", async () => {
    const { result, rows } = await measure(() =>
      loadEnabledAutomations(meteredDb.query, ["record", "fieldChanged"], [ITEM]),
    );
    expect(result.map((a) => a.id).sort()).toEqual([
      `${FIXTURE_ID}.onCreate`,
      `${FIXTURE_ID}.onLevel`,
    ]);
    expect(rows).toBeLessThanOrEqual(20);
    expect(await scans(["core_automations"])).toEqual([]);
  });

  it("an automation's runs page", async () => {
    const { result, rows } = await measure(() =>
      invokeByName(
        "automation.runs",
        { id: AUTOMATION, limit: 20 },
        {
          ...context(admin),
          db: meteredDb,
        },
      ),
    );
    expect((result as { items: unknown[] }).items).toHaveLength(20);
    expect(rows).toBeLessThanOrEqual(120);
    expect(await scans(["core_automation_runs"])).toEqual([]);
  });

  it("a record's runs (the per-record Automations section)", async () => {
    const { result, rows } = await measure(() =>
      invokeByName(
        "automation.runs",
        { record: { object: ITEM, id: "rec_7" }, limit: 50 },
        { ...context(admin), db: meteredDb },
      ),
    );
    expect((result as { items: unknown[] }).items).toHaveLength(12);
    expect(rows).toBeLessThanOrEqual(150);
    expect(await scans(["core_automation_runs", "core_automation_run_records"])).toEqual([]);
  });

  it("the rate counters and the fan-out count read by key", async () => {
    const { rows } = await measure(async () => {
      await meteredDb.query
        .selectFrom("core_automation_counters")
        .select("writes")
        .where("automation_id", "=", AUTOMATION)
        .where("hour", "=", new Date().toISOString().slice(0, 13))
        .executeTakeFirst();
      await meteredDb.query
        .selectFrom("core_automation_runs")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("root_event_id", "=", "aud_3")
        .executeTakeFirst();
    });
    expect(rows).toBeLessThanOrEqual(70);
    expect(await scans(["core_automation_counters", "core_automation_runs"])).toEqual([]);
  });

  it("the daily date-relative scan uses the date field's index", async () => {
    const { result, rows } = await measure(() =>
      recordsOnDate(meteredDb.query, ITEM, "due", "2027-01-10", 500),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(result.length * 2 + 10);
    expect(await scans(["x_autot_item"])).toEqual([]);
  });

  it("the retention purge takes the oldest runs of a status through its index", async () => {
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const { result, rows } = await measure(() =>
      purgeAutomationRuns(meteredDb.query, future, { chunk: 100, maxChunks: 2 }),
    );
    expect(result.deleted).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(2_500);
    expect(await scans(["core_automation_runs", "core_automation_run_records"])).toEqual([]);
  });
});
