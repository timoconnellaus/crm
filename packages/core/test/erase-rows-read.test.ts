// Rows read by an erase and by sync's erased-address check (ADR 0320), on a seeded database.
// Erase is rare and admin-run, so it may scan the tables free text can hide in (audit, activities,
// tasks, runs, notifications, events): the budget holds it to a small multiple of their size, so
// a lookup that turns into a scan per term or per record shows up. Sync is a hot path: the
// erased-address check is one primary-key lookup per batch, so it adds at most one row per
// distinct address.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { seedDatabase } from "@relationship-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, erasedAddresses, invokeByName, newId } from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { createUser, unique } from "./helpers.ts";

let rowsRead = 0;
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

let admin: ActingUser;
const NOTIFICATIONS = 1000;
const RUNS = 1000;

beforeAll(async () => {
  admin = await createUser("admin");
  await seedDatabase(env.DB, { people: 3000, organisations: 600, activities: 600, tasks: 400 });
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < NOTIFICATIONS; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO core_notifications (id, user_id, type, title, body, link, source, created_at) VALUES (?, ?, 'info', ?, 'Body', '/', '{}', ?)",
      ).bind(newId("record"), admin.id, `Notice ${i}`, now),
    );
  }
  for (let i = 0; i < RUNS; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, status, steps, started_at, updated_at) VALUES (?, 'aut_x', 'x', '{\"type\":\"schedule\"}', 'completed', '[]', ?, ?)",
      ).bind(newId("record"), now, now),
    );
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
}, 120_000);

async function tableRows(tables: string[]): Promise<number> {
  let n = 0;
  for (const t of tables) {
    n += (await env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0;
  }
  return n;
}

const ctx = () => ({
  actor: "human" as const,
  user: admin,
  origin: { surface: "ui" as const },
  db,
});

describe("erase rows read", () => {
  it("stays within a small multiple of the scanned tables", async () => {
    const email = `${unique("budget")}@budget.example`;
    const person = (await invokeByName(
      "person.create",
      {
        displayName: unique("Budget"),
        emails: [{ email }],
        phones: [{ number: "+1 555 0100 7777" }],
      },
      ctx(),
    )) as { id: string };
    const scanned = await tableRows([
      "core_audit",
      "core_audit_changes",
      "core_activity",
      "core_task",
      "core_pending_action",
      "core_automation_runs",
      "core_notifications",
      "core_integration_event",
      "core_job_change_suggestion",
      "core_extension_runs",
      "core_extension_kv",
      "core_search_docs",
    ]);
    rowsRead = 0;
    await invokeByName("person.erase", { id: person.id }, ctx());
    // Measured 4,362 rows against 7,603 in those tables (each free-text table is read at most
    // once; everything keyed by the subject is an index lookup). Before terms were bound one by
    // one it was 26,962: D1 bills every json_each row a join walks, once per scanned row.
    expect(rowsRead).toBeLessThan(scanned);
  });
});

describe("sync rows read", () => {
  it("the erased-address check is a primary-key lookup per batch", async () => {
    // A long erased-address list, then one batch's worth of addresses, two of them erased.
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 2000; i++) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
        ).bind(await erasedAddressHash(`gone${i}@list.example`), new Date().toISOString()),
      );
    }
    for (let i = 0; i < statements.length; i += 200)
      await env.DB.batch(statements.slice(i, i + 200));
    const addresses = [
      ...Array.from({ length: 40 }, (_, i) => `a${i}@${unique("ext")}.example`),
      "gone7@list.example",
      "gone1999@list.example",
    ];
    rowsRead = 0;
    const erased = await erasedAddresses(db.query, addresses);
    expect([...erased].sort()).toEqual(["gone1999@list.example", "gone7@list.example"]);
    // The json_each list of hashes is walked once and each is probed once: about two rows per
    // address, however long the list is.
    expect(rowsRead).toBeLessThanOrEqual(addresses.length * 2 + 4);
  });
});
