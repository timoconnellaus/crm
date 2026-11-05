// Rows read and statements written by the policy adjudicator (cost audit, ADR 0204) with many
// pending actions and verdicts on file: off costs one settings row and no writes; a judgement, the
// sweep, the agreement view and the inbox's verdicts walk indexes, never whole tables.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  adjudicatePendingAction,
  coreRegistry,
  invoke,
  type ModelRunner,
  newId,
  PendingApprovalError,
  runAdjudicatorSweep,
} from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

const PENDING = 400;
let rowsRead = 0;
let writes = 0;

/** env.DB, counting meta.rows_read for every statement, and the statements that write. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const writing = /^\s*(insert|update|delete|replace)/i.test(query);
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  if (writing) writes += 1;
                  const fn = s[p] as (...a: unknown[]) => Promise<unknown>;
                  if (p !== "all" && p !== "run") return fn.apply(s, args);
                  const result = (await fn.apply(s, args)) as D1Result;
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
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        writes += statements.length;
        const results = await target.batch(statements);
        for (const r of results) rowsRead += r.meta.rows_read;
        return results;
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

const reviewer: ModelRunner = {
  run: async () => ({
    text: JSON.stringify({ verdict: "escalate", confidence: 0.5, reason: "Unsure." }),
    model: "fake",
  }),
};
const deps = { db, models: reviewer, resolveOperation: (n: string) => coreRegistry.get(n) };

let admin: ActingUser;
let member: ActingUser;
let fresh: { actionId: string; changeSetId: string };

async function setMode(mode: "off" | "shadow") {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES ('adjudicator', ?, ?)",
  )
    .bind(JSON.stringify({ mode, threshold: 0.8, enabledAt: null }), new Date().toISOString())
    .run();
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await invoke("adjudicator.setPolicy", { text: "Escalate everything." }, context(admin));
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const set = newId("changeSet");
  await env.DB.prepare(
    "INSERT INTO core_change_set (id, user_id, actor, origin, created_at, updated_at) VALUES (?, ?, 'mcp', '{}', ?, ?)",
  )
    .bind(set, member.id, now, now)
    .run();
  // Many pending actions, half of them already judged, plus decided history.
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < PENDING; i++) {
    const id = newId("pendingAction");
    const status = i % 4 === 0 ? "applied" : "pending";
    statements.push(
      env.DB.prepare(
        `INSERT INTO core_pending_action (id, change_set_id, operation, risk, input, reason, actor,
          user_id, origin, preview, simulated, status, created_at, expires_at, review_source, decided_by)
         VALUES (?, ?, 'person.create', 'write', '{}', 'r', 'mcp', ?, '{}', '[]', '{}', ?, ?, ?, 'policy', ?)`,
      ).bind(id, set, member.id, status, old, expires, status === "applied" ? admin.id : null),
    );
    if (i % 2 === 0) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO core_adjudication (id, action_id, judged_at, mode, verdict, confidence, reason,
            outcome, threshold, audit_id) VALUES (?, ?, ?, 'shadow', 'approve', 0.9, 'r', 'recorded', 0.8, 'aud_x')`,
        ).bind(newId("adjudication"), id, i % 8 === 0 ? old : "2026-01-01T00:00:00.000Z"),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }
  // One real queued action.
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset: "cautious" }))
    .run();
  const error = await invoke(
    "person.create",
    { displayName: "Metered" },
    context(member, { actor: "mcp", origin: { surface: "mcp", sessionId: "cap_metered" } }),
  ).catch((e: unknown) => e);
  if (!(error instanceof PendingApprovalError)) throw new Error("expected a pending action");
  fresh = { actionId: error.pending.actionId, changeSetId: error.pending.changeSetId };
}, 120_000);

describe("rows read by the policy adjudicator", () => {
  it("off: one settings row, no writes, no model call", async () => {
    await setMode("off");
    rowsRead = 0;
    writes = 0;
    expect(await adjudicatePendingAction(deps, fresh.actionId)).toMatchObject({ why: "off" });
    expect(rowsRead).toBeLessThanOrEqual(1);
    expect(writes).toBe(0);
    rowsRead = 0;
    expect((await runAdjudicatorSweep(deps)).judged).toBe(0);
    expect(rowsRead).toBeLessThanOrEqual(1);
  });

  it("a judgement reads the action, its set and verdict by key", async () => {
    await setMode("shadow");
    rowsRead = 0;
    writes = 0;
    expect(await adjudicatePendingAction(deps, fresh.actionId)).toMatchObject({
      status: "judged",
    });
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThan(40);
    // One batch: the verdict and its audit row.
    expect(writes).toBe(2);
  });

  it("the sweep walks pending actions by index, bounded by its limit", async () => {
    await setMode("shadow");
    rowsRead = 0;
    const out = await runAdjudicatorSweep(deps, { limit: 5 });
    expect(out.judged).toBe(5);
    // The candidate query reads at most the pending rows and their verdict index entries.
    expect(rowsRead).toBeLessThan(PENDING * 2 + 5 * 40);
  });

  it("the agreement view reads the period's verdicts by index", async () => {
    rowsRead = 0;
    await invoke("adjudicator.agreement", { days: 7 }, { ...context(admin), db });
    // Recent verdicts only (about PENDING / 8 seeded plus the ones judged above), not the table.
    expect(rowsRead).toBeLessThan(PENDING / 8 * 2 + 100);
  });

  it("the inbox reads verdicts by action id", async () => {
    rowsRead = 0;
    const out = await invoke(
      "approval.get",
      { changeSetId: fresh.changeSetId },
      { ...context(member), db },
    );
    expect(out.actions[0]?.adjudication).not.toBeNull();
    expect(rowsRead).toBeLessThan(50);
  });
});
