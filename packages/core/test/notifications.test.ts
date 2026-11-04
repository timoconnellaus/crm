// Notifications (ADR 0029, ADR 0132): recipient resolution (user ids, admins, a record's user
// field, managerOf → admins with a note), dedupe, notification.send in the operation's batch,
// the per-user inbox (list, unread count, mark read), links → app paths, retention, and that the
// inbox queries keep to their indexes (EXPLAIN QUERY PLAN, rows read).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@crm/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  adminUserIds,
  invoke,
  NO_MANAGER_NOTE,
  newId,
  notificationHref,
  notifyStatements,
  purgeNotifications,
  ValidationError,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

let admin: ActingUser;
let admin2: ActingUser;
let member: ActingUser;
let other: ActingUser;
const ext = extId("ntf");
const object = `${ext}.ticket`;

beforeAll(async () => {
  admin = await createUser("admin");
  admin2 = await createUser("admin");
  member = await createUser("member");
  other = await createUser("member");
  await reconcile(
    manifest(ext, {
      objects: {
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "subject",
          fields: {
            subject: { type: "text", label: "Subject", required: true },
            owner: { type: "user", label: "Owner" },
          },
        },
      },
    }),
  );
});

async function ticket(owner: string | null): Promise<string> {
  const created = (await invoke(
    "record.create",
    { object, values: { subject: "Broken", owner } },
    context(admin),
  )) as { id: string };
  return created.id;
}

async function rows(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_notifications WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(userId)
    .all<Record<string, unknown>>();
  return results;
}

const source = { actor: "automation", automationId: "deals.wonOnboarding", runId: "arn_1" };

describe("recipient resolution", () => {
  it("resolves user ids, admins and a record's user field, deduplicated", async () => {
    const id = await ticket(member.id);
    const plan = await notifyStatements(
      db.query,
      {
        to: [
          { userId: member.id },
          { role: "admin" },
          { field: "owner", record: { object, id } },
          { userId: admin.id },
        ],
        type: "automation.message",
        title: "Hello",
        source,
      },
      new Date().toISOString(),
    );
    const admins = await adminUserIds(db.query);
    expect(admins).toEqual(expect.arrayContaining([admin.id, admin2.id]));
    expect(admins).not.toContain(member.id);
    expect(plan.userIds).toEqual([member.id, ...admins]);
    expect(plan.statements).toHaveLength(plan.userIds.length);
    expect(plan.notes).toEqual([]);
  });

  it("sends managerOf to the admins, with a note, because users have no manager field", async () => {
    const id = await ticket(member.id);
    const plan = await notifyStatements(
      db.query,
      {
        to: [{ managerOf: "owner", record: { object, id } }],
        type: "automation.message",
        title: "Onboarding not started",
        source,
      },
      new Date().toISOString(),
    );
    expect(plan.userIds).toEqual(await adminUserIds(db.query));
    expect(plan.notes).toEqual([NO_MANAGER_NOTE]);
  });

  it("reads core user-id fields (a person's owner) and notes an empty field", async () => {
    const person = (await invoke(
      "person.create",
      { givenName: "Ada", ownerId: other.id },
      context(admin),
    )) as { id: string };
    const plan = await notifyStatements(
      db.query,
      {
        to: [{ field: "ownerId", record: { object: "person", id: person.id } }],
        type: "system.message",
        title: "x",
        source,
      },
      new Date().toISOString(),
    );
    expect(plan.userIds).toEqual([other.id]);

    const empty = await ticket(null);
    const none = await notifyStatements(
      db.query,
      {
        to: [{ field: "owner", record: { object, id: empty } }],
        type: "system.message",
        title: "x",
        source,
      },
      new Date().toISOString(),
    );
    expect(none.userIds).toEqual([]);
    expect(none.notes[0]).toMatch(/has no owner: nobody to notify/);
  });

  it("refuses unknown user ids and fields that are not user fields", async () => {
    const id = await ticket(member.id);
    const base = { type: "system.message" as const, title: "x", source };
    await expect(
      notifyStatements(db.query, { ...base, to: [{ userId: "usr_nope" }] }, "2026-01-01T00:00:00Z"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      notifyStatements(
        db.query,
        { ...base, to: [{ field: "subject", record: { object, id } }] },
        "2026-01-01T00:00:00Z",
      ),
    ).rejects.toThrow(/no user field "subject"/);
  });
});

describe("notification.send", () => {
  it("writes one notification per recipient in the operation's batch, deduped by key", async () => {
    const id = await ticket(member.id);
    const input = {
      to: [{ field: "owner", record: { object, id } }, { userId: member.id }],
      title: "Deal won 🎉 onboarding tasks created",
      link: { kind: "record" as const, object, id },
      dedupeKey: `won:${id}`,
    };
    const ctx = context(admin, {
      actor: "automation",
      origin: { surface: "automation", automationId: "deals.wonOnboarding", runId: "arn_x" },
    });
    const out = await invoke("notification.send", input, ctx);
    expect(out).toEqual({ sent: 1, userIds: [member.id], notes: [] });
    // The same key again is ignored (INSERT OR IGNORE on the dedupe index).
    await invoke("notification.send", input, ctx);
    const mine = (await rows(member.id)).filter((r) => r.dedupe_key === `won:${id}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "automation.message", read_at: null });
    expect(JSON.parse(String(mine[0]?.source))).toEqual({
      actor: "automation",
      userId: admin.id,
      automationId: "deals.wonOnboarding",
      runId: "arn_x",
    });
  });

  it("defaults to system.message for people and refuses host-only types", async () => {
    await invoke("notification.send", { to: [{ userId: other.id }], title: "Hi" }, context(admin));
    expect((await rows(other.id)).at(-1)).toMatchObject({ type: "system.message", title: "Hi" });
    await expect(
      invoke(
        "notification.send",
        { to: [{ userId: other.id }], title: "x", type: "approval.pending" },
        context(admin),
      ),
    ).rejects.toThrow(/sent by the CRM itself/);
  });
});

describe("the inbox", () => {
  let reader: ActingUser;
  beforeAll(async () => {
    reader = await createUser("viewer");
    const stmt = env.DB.prepare(
      "INSERT INTO core_notifications (id, user_id, type, title, link, created_at) VALUES (?, ?, 'system.message', ?, ?, ?)",
    );
    await env.DB.batch(
      Array.from({ length: 5 }, (_, i) =>
        stmt.bind(
          newId("notification"),
          reader.id,
          `n${i}`,
          JSON.stringify({ kind: "approval", changeSetId: `chs_${i}` }),
          `2026-11-0${i + 1}T00:00:00.000Z`,
        ),
      ),
    );
  });

  it("lists only your own, newest first, with cursors, hrefs and the unread count", async () => {
    const first = await invoke("notification.list", { limit: 3 }, context(reader));
    expect(first.items.map((n) => n.title)).toEqual(["n4", "n3", "n2"]);
    expect(first.unread).toBe(5);
    expect(first.items[0]?.href).toBe("/approvals?set=chs_4");
    expect(first.nextCursor).not.toBeNull();
    const second = await invoke(
      "notification.list",
      { limit: 3, cursor: first.nextCursor ?? undefined },
      context(reader),
    );
    expect(second.items.map((n) => n.title)).toEqual(["n1", "n0"]);
    expect(second.nextCursor).toBeNull();
    // Another user sees none of them.
    const theirs = await invoke("notification.list", {}, context(other));
    expect(theirs.items.some((n) => n.title.startsWith("n"))).toBe(false);
  });

  it("marks your own read (by id or all), never someone else's", async () => {
    const { items } = await invoke("notification.list", { limit: 2 }, context(reader));
    const ids = items.map((n) => n.id);
    // Not yours: nothing changes.
    expect(await invoke("notification.markRead", { ids }, context(other))).toEqual({ updated: 0 });
    expect(await invoke("notification.markRead", { ids }, context(reader))).toEqual({
      updated: 2,
    });
    expect(await invoke("notification.unreadCount", {}, context(reader))).toEqual({ unread: 3 });
    const unread = await invoke("notification.list", { unreadOnly: true }, context(reader));
    expect(unread.items.map((n) => n.title)).toEqual(["n2", "n1", "n0"]);
    expect(await invoke("notification.markRead", { all: true }, context(reader))).toEqual({
      updated: 3,
    });
    expect(await invoke("notification.unreadCount", {}, context(reader))).toEqual({ unread: 0 });
  });

  it("maps links to app paths", () => {
    expect(notificationHref({ kind: "record", object: "person", id: "per_1" })).toBe(
      "/people/per_1",
    );
    expect(notificationHref({ kind: "record", object: "organisation", id: "org_1" })).toBe(
      "/organisations/org_1",
    );
    expect(notificationHref({ kind: "record", object: "deals.deal", id: "rec_1" })).toBe(
      "/x/deals.deal/rec_1",
    );
    expect(
      notificationHref({
        kind: "automationRun",
        automationId: "deals.wonOnboarding",
        runId: "arn_1",
      }),
    ).toBe("/automations/deals.wonOnboarding?run=arn_1");
    expect(notificationHref({ kind: "automation", automationId: "deals.stalled" })).toBe(
      "/automations/deals.stalled",
    );
    expect(notificationHref(null)).toBeNull();
  });
});

// --- Cost: indexes, rows read, retention ----------------------------------------------------

let rowsRead = 0;
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all" || p === "run" || p === "first") {
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
const meteredDb = createCrmDb(metered);

async function plan(query: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

describe("cost", () => {
  let busy: ActingUser;
  let light: ActingUser;
  beforeAll(async () => {
    busy = await createUser("member");
    light = await createUser("member");
    // 3,000 notifications for someone else, 40 for `light` (10 unread).
    await env.DB.prepare(
      `INSERT INTO core_notifications (id, user_id, type, title, created_at, read_at)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 3000)
       SELECT printf('ntf_busy%06d', i), ?, 'system.message', 'x',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01', '+' || i || ' minutes'), NULL FROM k`,
    )
      .bind(busy.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_notifications (id, user_id, type, title, created_at, read_at)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 40)
       SELECT printf('ntf_light%06d', i), ?, 'system.message', 'x',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01', '+' || i || ' minutes'),
         CASE WHEN i <= 30 THEN '2026-10-02T00:00:00.000Z' END FROM k`,
    )
      .bind(light.id)
      .run();
  });

  it("lists a page and counts unread through the user indexes", async () => {
    const list = await plan(
      "SELECT id FROM core_notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 31",
      light.id,
    );
    expect(list).toMatch(/core_notifications_user_idx/);
    expect(list).not.toMatch(/^SCAN core_notifications$/m);
    const count = await plan(
      "SELECT count(*) FROM (SELECT 1 FROM core_notifications INDEXED BY core_notifications_unread_idx WHERE user_id = ? AND read_at IS NULL LIMIT 1000)",
      light.id,
    );
    expect(count).toMatch(/core_notifications_unread_idx/);
  });

  it("reads about a page, not the table, per list and unread count", async () => {
    const ctx = context(light, { db: meteredDb });
    rowsRead = 0;
    const page = await invoke("notification.list", { limit: 30 }, ctx);
    expect(page.items).toHaveLength(30);
    expect(page.unread).toBe(10);
    expect(rowsRead).toBeLessThan(150);
    rowsRead = 0;
    expect(await invoke("notification.unreadCount", {}, ctx)).toEqual({ unread: 10 });
    expect(rowsRead).toBeLessThan(40);
  });

  it("purges notifications older than 90 days in index-ordered chunks", async () => {
    const now = "2027-01-15T00:00:00.000Z"; // cutoff 2026-10-17: every seeded row is older
    const recent = newId("notification");
    await env.DB.prepare(
      "INSERT INTO core_notifications (id, user_id, type, title, created_at) VALUES (?, ?, 'system.message', 'recent', ?)",
    )
      .bind(recent, light.id, "2027-01-10T00:00:00.000Z")
      .run();
    const purgePlan = await plan(
      "SELECT id FROM core_notifications WHERE created_at < ? ORDER BY created_at LIMIT 500",
      "2026-10-17T00:00:00.000Z",
    );
    expect(purgePlan).toMatch(/core_notifications_created_idx/);
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE created_at < '2026-10-17T00:00:00.000Z'",
    ).first<{ n: number }>();
    rowsRead = 0;
    const result = await purgeNotifications(meteredDb.query, now, { chunk: 1000 });
    expect(result).toEqual({ deleted: Number(before?.n), more: false });
    expect(rowsRead).toBeLessThan(Number(before?.n) * 8);
    const left = await env.DB.prepare("SELECT id FROM core_notifications WHERE id = ?")
      .bind(recent)
      .first();
    expect(left).not.toBeNull();
  });
});
