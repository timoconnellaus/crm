// Stage 6b queries keep to their indexes (ADR 0170, 0171, 0173; cost audit): the integration
// events poll (the unconsumed partial index), run-as binding lookups (primary key and the live
// connection index), revocation, and the outbox retry (one primary-key page). rows_read budgets
// and EXPLAIN QUERY PLAN checks, on tables seeded so an unindexed read would show.
import { env } from "cloudflare:workers";
import { liveBinding, loadBindings, retryOutbox, revokeBindingsPlan } from "@crm/core";
import { createCrmDb } from "@crm/db";
import { beforeAll, describe, expect, it } from "vitest";
import { pollIntegrationEvents } from "../src/automations/integration-events.ts";

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

const AT = new Date().toISOString();

beforeAll(async () => {
  const statements: D1PreparedStatement[] = [];
  // 3,000 consumed events and 5 waiting ones.
  for (let i = 0; i < 3005; i++) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO core_integration_event (id, source, connection_id, type, payload, occurred_at, created_at, consumed_at) VALUES (?, 'webhook', 'conn_x', 'invoice.paid', '{"endpointId":"none"}', ?, ?, ?)`,
      ).bind(`iev_${String(i).padStart(26, "0")}`, AT, AT, i < 3000 ? AT : null),
    );
  }
  // 1,000 bindings over 100 automations and 50 connections, half revoked.
  for (let i = 0; i < 1000; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO core_automation_binding (automation_id, slot, gatekeeper, purpose, connection_id, bound_by, bound_at, revoked_at) VALUES (?, ?, 'fake', 'p', ?, 'usr_x', ?, ?)",
      ).bind(`ext.a${i % 100}`, `s${Math.floor(i / 100)}`, `conn_${i % 50}`, AT, i % 2 ? AT : null),
    );
  }
  for (let i = 0; i < 100; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO core_automations (id, extension_id, key, label, trigger_type, trigger_object, spec, enabled, created_at, updated_at) VALUES (?, 'ext', ?, 'A', 'manual', NULL, '{}', 1, ?, ?)",
      ).bind(`ext.a${i}`, `a${i}`, AT, AT),
    );
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
});

describe("stage 6b rows read and query plans", () => {
  it("the integration events poll reads only the unconsumed rows", async () => {
    const { result, rows } = await measure(() =>
      pollIntegrationEvents({ ...env, DB: metered } as typeof env),
    );
    expect(result.consumed).toBe(5);
    // The poll itself plus dispatch's settings, schema registry and automation lookups.
    expect(rows).toBeLessThanOrEqual(400);
    expect(await scans(["core_integration_event"])).toEqual([]);
    const idle = await measure(() => pollIntegrationEvents({ ...env, DB: metered } as typeof env));
    expect(idle.result.consumed).toBe(0);
    expect(idle.rows).toBeLessThanOrEqual(5);
  });

  it("binding lookups read by key", async () => {
    const { result, rows } = await measure(async () => {
      const all = await loadBindings(meteredDb.query, ["ext.a7", "ext.a8"]);
      const one = await liveBinding(meteredDb.query, "ext.a8", "s0");
      return { all, one };
    });
    expect(result.all).toHaveLength(20);
    expect(rows).toBeLessThanOrEqual(30);
    expect(await scans(["core_automation_binding"])).toEqual([]);
  });

  it("revocation finds the live bindings of a connection through its index", async () => {
    const { result, rows } = await measure(() =>
      revokeBindingsPlan(
        meteredDb.query,
        { connectionId: "conn_4" },
        { reason: "r", by: null, now: AT },
      ),
    );
    expect(result.revoked).toBe(20);
    expect(rows).toBeLessThanOrEqual(80);
    expect(await scans(["core_automation_binding", "core_automations"])).toEqual([]);
    // Applying it pauses only the automations bound to that connection.
    await env.DB.prepare(
      "INSERT INTO core_automations (id, extension_id, key, label, trigger_type, spec, enabled, paused_reason, created_at, updated_at) VALUES ('ext.waiting', 'ext', 'waiting', 'W', 'manual', '{}', 1, 'Waiting for connections', ?, ?)",
    )
      .bind(AT, AT)
      .run();
    await createCrmDb(env.DB).batch(result.statements);
    const { results } = await env.DB.prepare(
      "SELECT id, paused_reason FROM core_automations WHERE paused_reason IS NOT NULL ORDER BY id",
    ).all<{ id: string; paused_reason: string }>();
    expect(results.find((r) => r.id === "ext.waiting")?.paused_reason).toBe(
      "Waiting for connections",
    );
    expect(results.filter((r) => r.paused_reason.startsWith("Connection revoked"))).toHaveLength(
      result.automationIds.length,
    );
  });

  it("the outbox retry reads one page in key order and nothing when empty", async () => {
    const { result, rows } = await measure(() => retryOutbox(meteredDb, async () => {}));
    expect(result.read).toBe(0);
    expect(rows).toBeLessThanOrEqual(1);
    expect(await scans(["core_automation_outbox"])).toEqual([]);
  });
});
