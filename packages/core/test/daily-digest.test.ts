// The daily digest (stage 7 AC 6, ADR 0206) against real D1, with a fake email transport and a
// stub model runner (never a real model): its sections (changes others made to my records, tasks
// due and overdue, approvals for approvers only, unread notices; never activities), in-app and
// email delivery, the in-app preference, exactly once per person per day across repeated ticks
// and a lost cron state, the labelled AI overview and its fallback, and the reads it costs.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CallIntegration,
  DEFAULT_DELIVERY_SETTINGS,
  type DigestInput,
  invokeByName,
  type ModelMessage,
  type ModelRunner,
  NOTIFICATION_DELIVERY_STATE_SETTING,
  newId,
  PendingApprovalError,
  plainDigest,
  runNotificationDelivery,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

// A synthetic clock: each scenario runs on its own day (the cron's digest day is one row).
let clock = Date.parse("2032-03-10T06:00:00.000Z");
const now = () => new Date(clock);
const MINUTE = 60_000;
/** Moves to `hour`:`minute` UTC of `days` days later. */
function moveTo(days: number, hour: number, minute = 0): Date {
  const next = new Date(clock);
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(hour, minute, 0, 0);
  clock = next.getTime();
  return now();
}
const today = () => now().toISOString().slice(0, 10);
const shift = (days: number) => {
  const d = new Date(clock);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Call = Parameters<CallIntegration>[0];
const calls: Call[] = [];
const fakeCall: CallIntegration = async (input) => {
  calls.push(input);
  return { value: { status: "sent" }, pending: [], applied: [{ action: 1 }] };
};

/** A stub model runner recording each call (never a real model). */
function stubModels(answer: (messages: readonly ModelMessage[]) => string) {
  const runs: { role: string; messages: readonly ModelMessage[] }[] = [];
  const models: ModelRunner = {
    async run(role, messages) {
      runs.push({ role, messages });
      return { text: answer(messages), model: "stub", provider: "fake" };
    },
  };
  return { models, runs };
}

let emailConnection: string;
function tick(extra: Partial<Parameters<typeof runNotificationDelivery>[0]> = {}) {
  return runNotificationDelivery({
    db: db.query,
    now: now(),
    appOrigin: "https://crm.test",
    callIntegration: fakeCall,
    ...extra,
  });
}
const withEmail = () => ({ ...DEFAULT_DELIVERY_SETTINGS, email: emailConnection });

async function digestNotice(userId: string, date = today()) {
  return env.DB.prepare(
    "SELECT id, title, body, source, type, link FROM core_notifications WHERE user_id = ? AND dedupe_key = ?",
  )
    .bind(userId, `digest:${date}`)
    .first<{ id: string; title: string; body: string; source: string; type: string }>();
}

async function digestCount(userId: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_notifications WHERE user_id = ? AND type = 'digest'",
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

let owner: ActingUser;
let other: ActingUser;
let viewer: ActingUser;
let admin: ActingUser;
const ctx = (user: ActingUser, extra: Record<string, unknown> = {}) =>
  context(user, { clock: now, ...extra });

beforeAll(async () => {
  admin = await createUser("admin");
  owner = await createUser("member");
  other = await createUser("member");
  viewer = await createUser("viewer");
  emailConnection = newId("connection");
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Email', 'active', ?, ?, ?)",
  )
    .bind(
      emailConnection,
      admin.id,
      JSON.stringify([
        {
          key: "k1",
          url: "email-send://sender/crm%40example.com",
          pattern: "email-send://sender/:address",
          title: "Email",
          tsType: "X",
          bindingName: "X",
        },
      ]),
      at,
      at,
    )
    .run();
});

/** Records for one day's digest; returns their ids. */
async function setUpDay() {
  // My person, created by me (left out), then changed by someone else (listed).
  const ada = await invoke(
    "person.create",
    { displayName: `Ada ${unique()}`, ownerId: owner.id },
    ctx(owner),
  );
  await invoke("person.update", { id: ada.id, location: "Paris" }, ctx(other));
  // My organisation, changed by me (left out) and by the assistant acting for me (listed).
  const acme = await invoke(
    "organisation.create",
    { name: `Acme ${unique()}`, ownerId: owner.id },
    ctx(owner),
  );
  await invoke("organisation.update", { id: acme.id, industry: "Software" }, ctx(owner));
  await setPreset("autonomous");
  await invoke(
    "organisation.update",
    { id: acme.id, website: "https://acme.test" },
    ctx(owner, { actor: "assistant" }),
  );
  await setPreset("balanced");
  // A person someone else created and gave me.
  const bob = await invoke(
    "person.create",
    { displayName: `Bob ${unique()}`, ownerId: owner.id },
    ctx(other),
  );
  // Someone else's person, changed by me: in their digest, not mine.
  const theirs = await invoke(
    "person.create",
    { displayName: `Cleo ${unique()}`, ownerId: other.id },
    ctx(other),
  );
  await invoke("person.update", { id: theirs.id, location: "Rome" }, ctx(owner));
  // A note on my person by someone else, and a private one: activities are never listed.
  await invoke(
    "activity.log",
    { type: "note", body: "Board talk", links: [{ object: "person", id: ada.id }] },
    ctx(other),
  );
  await invoke(
    "activity.log",
    { type: "note", body: "Private", private: true, links: [{ object: "person", id: ada.id }] },
    ctx(other),
  );
  // Tasks assigned to me: overdue, due today, due tomorrow, and one done.
  const overdue = await invoke(
    "task.create",
    { title: `Overdue ${unique()}`, dueAt: shift(-2), assigneeId: owner.id },
    ctx(other),
  );
  const dueToday = await invoke(
    "task.create",
    { title: `Today ${unique()}`, dueAt: today(), assigneeId: owner.id },
    ctx(owner),
  );
  const tomorrow = await invoke(
    "task.create",
    { title: `Tomorrow ${unique()}`, dueAt: shift(1), assigneeId: owner.id },
    ctx(owner),
  );
  const done = await invoke(
    "task.create",
    { title: `Done ${unique()}`, dueAt: shift(-1), assigneeId: owner.id },
    ctx(owner),
  );
  await invoke("task.complete", { id: done.id }, ctx(owner));
  return { ada, acme, bob, theirs, overdue, dueToday, tomorrow, done };
}

async function invoke(name: string, input: unknown, c: ReturnType<typeof ctx>) {
  // biome-ignore lint/suspicious/noExplicitAny: test helper over every operation's output.
  return (await invokeByName(name, input, c)) as any;
}

describe("the daily digest's content", () => {
  let day: Awaited<ReturnType<typeof setUpDay>>;
  let body = "";

  beforeAll(async () => {
    moveTo(0, 6);
    day = await setUpDay();
    // A change waiting for approval: the assistant's edit under the cautious preset.
    await setPreset("cautious");
    await expect(
      invoke(
        "person.update",
        { id: day.bob.id, location: "Oslo" },
        ctx(owner, { actor: "assistant" }),
      ),
    ).rejects.toBeInstanceOf(PendingApprovalError);
    await setPreset("balanced");
    moveTo(0, 8, 1);
    await tick();
    body = (await digestNotice(owner.id))?.body ?? "";
  });

  it("lists changes others made to my records, not my own, and never activities", async () => {
    const notice = await digestNotice(owner.id);
    expect(notice).toMatchObject({ type: "digest", title: `Your daily digest for ${today()}` });
    expect(body).toContain("### Changes on your records");
    expect(body).toContain(`/people/${day.ada.id}`);
    expect(body).toContain("updated by member user (Location)");
    expect(body).toContain(`/organisations/${day.acme.id}`);
    expect(body).toContain("updated by AI assistant (Website)");
    expect(body).not.toContain("Industry");
    expect(body).toContain(`/people/${day.bob.id}`);
    expect(body).toContain("created by member user");
    // The overdue task someone else created for me is a change too.
    expect(body).toContain("Overdue");
    // Not someone else's record, not activities.
    expect(body).not.toContain(day.theirs.id);
    expect(body).not.toContain("Board talk");
    expect(body).not.toContain("Private");
    expect(body).not.toContain("/activity");
  });

  it("lists my tasks due today and overdue, not later or done ones", () => {
    const tasks = body.slice(body.indexOf("### Tasks due"));
    expect(tasks).toContain(`${day.overdue.title}](/tasks): overdue since ${shift(-2)}`);
    expect(tasks).toContain(`${day.dueToday.title}](/tasks): due today`);
    expect(tasks).not.toContain(day.tomorrow.title);
    expect(tasks).not.toContain(day.done.title);
  });

  it("shows approvals waiting to people who can approve only", async () => {
    expect(body).toContain("### Approvals waiting");
    expect(body).toContain("](/approvals)");
    const adminDigest = await digestNotice(admin.id);
    expect(adminDigest?.body).toContain("### Approvals waiting");
    expect(adminDigest?.body).not.toContain("### Changes on your records");
    // The viewer cannot approve and owns nothing: no digest at all.
    expect(await digestNotice(viewer.id)).toBeNull();
    // Someone else's record I changed shows in their digest.
    expect((await digestNotice(other.id))?.body).toContain(`/people/${day.theirs.id}`);
  });

  it("arrives once a day, across repeated ticks and a lost cron state", async () => {
    await tick();
    clock += 3 * 60 * MINUTE;
    await tick();
    await env.DB.prepare("DELETE FROM core_settings WHERE key = ?")
      .bind(NOTIFICATION_DELIVERY_STATE_SETTING)
      .run();
    const again = await tick();
    expect(again.digests.map((d) => d.status)).toEqual(again.digests.map(() => "duplicate"));
    expect(await digestCount(owner.id)).toBe(1);
  });
});

describe("delivery", () => {
  it("emails the digest with absolute links when asked, and in-app too by default", async () => {
    moveTo(1, 6);
    const day = await setUpDay();
    await invoke("notification.setPreferences", { digest: true }, ctx(owner));
    calls.length = 0;
    const inputs: DigestInput[] = [];
    moveTo(0, 9);
    const report = await tick({
      settings: withEmail(),
      composeDigest: (input) => {
        inputs.push(input);
        return plainDigest(input);
      },
    });
    const key = `digest:${today()}:${owner.id}`;
    expect(report.digests).toContainEqual({ key, status: "sent", detail: "in-app" });
    expect(inputs.map((i) => i.recipient.userId)).toEqual([owner.id]);
    const email = calls.find((c) => c.method === "send");
    const text = String((email?.args[0] as { text?: string } | undefined)?.text);
    expect(text).toContain("Changes on your records:");
    expect(text).toContain(`https://crm.test/people/${day.ada.id}`);
    expect(text).toContain("Tasks due:");
    expect(text).toContain("overdue since");
    expect(text).not.toContain("AI-generated");
    expect(await digestNotice(owner.id)).not.toBeNull();
  });

  it("turning the in-app digest off stops it; the email stays", async () => {
    moveTo(1, 6);
    await setUpDay();
    await invoke("notification.setPreferences", { digestInApp: false }, ctx(owner));
    expect(await invoke("notification.preferences", {}, ctx(owner))).toMatchObject({
      digest: true,
      digestInApp: false,
    });
    calls.length = 0;
    moveTo(0, 8);
    await tick({ settings: withEmail() });
    expect(await digestNotice(owner.id)).toBeNull();
    expect(calls.filter((c) => c.method === "send")).toHaveLength(1);
    // Back to the defaults for the scenarios that follow.
    await invoke("notification.setPreferences", { digestInApp: true, digest: false }, ctx(owner));
  });

  it("is not a type anyone routes to a channel", async () => {
    const prefs = await invoke("notification.preferences", {}, ctx(owner));
    expect(prefs.types.map((t: { type: string }) => t.type)).not.toContain("digest");
    await expect(
      invoke("notification.setPreferences", { channels: { digest: ["email"] } }, ctx(owner)),
    ).rejects.toThrow();
  });
});

describe("the AI overview", () => {
  it("opens the digest, labelled, from one summarise call per person per day", async () => {
    moveTo(1, 6);
    await setUpDay();
    const { models, runs } = stubModels(
      () => "**Two** of your records changed and a task is overdue.",
    );
    moveTo(0, 8);
    await tick({ models });
    await tick({ models });
    const mine = runs.filter((r) => r.messages.some((m) => m.content.includes("Overdue")));
    expect(mine.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.role === "summarise")).toBe(true);
    const notice = await digestNotice(owner.id);
    expect(notice?.body.startsWith("_AI-generated overview:_ Two of your records changed")).toBe(
      true,
    );
    expect(JSON.parse(notice?.source ?? "{}")).toMatchObject({ aiGenerated: true });
    // One call per digest sent: the second tick asked nothing.
    const sent = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notification_delivery WHERE key LIKE ?",
    )
      .bind(`digest:${today()}:%`)
      .first<{ n: number }>();
    expect(runs).toHaveLength(Number(sent?.n));
    // The facts never carry activity text.
    expect(runs.flatMap((r) => r.messages.map((m) => m.content)).join("\n")).not.toContain(
      "Board talk",
    );
  });

  it("falls back to the plain digest when the model fails", async () => {
    moveTo(1, 6);
    await setUpDay();
    const models: ModelRunner = {
      async run() {
        throw new Error("model down");
      },
    };
    moveTo(0, 8);
    const report = await tick({ models });
    expect(report.digests).toContainEqual({
      key: `digest:${today()}:${owner.id}`,
      status: "sent",
      detail: "in-app",
    });
    const notice = await digestNotice(owner.id);
    expect(notice?.body).not.toContain("AI-generated");
    expect(notice?.body).toContain("### Changes on your records");
    expect(JSON.parse(notice?.source ?? "{}")).not.toHaveProperty("aiGenerated");
  });
});

// --- Cost --------------------------------------------------------------------------------------

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
              if (p === "all") {
                return async () => {
                  recorded.push({ sql: query, params });
                  const result = await s.all();
                  rowsRead += result.meta.rows_read;
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
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const meteredDb = createCrmDb(metered);

async function scans(): Promise<string[]> {
  const tables = [
    "core_audit",
    "core_audit_changes",
    "core_task",
    "core_notifications",
    "core_user",
  ];
  const found: string[] = [];
  for (const { sql, params } of recorded) {
    if (!/^\s*(SELECT|WITH)/i.test(sql)) continue;
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    for (const { detail } of plan.results) {
      for (const table of tables) {
        if (new RegExp(`^SCAN ${table}\\b`).test(detail) && !/USING .*INDEX/.test(detail)) {
          found.push(`${detail} :: ${sql}`);
        }
      }
    }
  }
  return found;
}

describe("cost", () => {
  it("reads the last day's changes through the audit time index, bounded, once per tick", async () => {
    moveTo(1, 6);
    // 20,000 older audit rows with a change each, and 3,000 tasks of someone else.
    const old = new Date(clock - 3 * 86_400_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO core_audit (id, at, operation, risk, actor, user_id, origin, input, gate_decision, outcome)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 20000)
       SELECT printf('aud_old%06d', i), ?, 'person.update', 'write', 'human', ?, '{}', '{}', 'auto', 'ok' FROM k`,
    )
      .bind(old, other.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_audit_changes (audit_id, object_type, record_id, action, diff, at)
       SELECT id, 'person', 'per_missing', 'update', '{"location":{}}', at FROM core_audit
       WHERE id LIKE 'aud_old%'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO core_task (id, title, due_at, status, assignee_id, created_at, updated_at)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 3000)
       SELECT printf('tsk_old%06d', i), 'Theirs', '2030-01-01', 'open', ?, ?, ? FROM k`,
    )
      .bind(other.id, old, old)
      .run();
    // A busy day: 1,500 changes in the last 24 hours (more than one tick reads).
    const recent = new Date(clock - 3_600_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO core_audit (id, at, operation, risk, actor, user_id, origin, input, gate_decision, outcome)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 1500)
       SELECT printf('aud_new%06d', i), ?, 'person.update', 'write', 'human', ?, '{}', '{}', 'auto', 'ok' FROM k`,
    )
      .bind(recent, other.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_audit_changes (audit_id, object_type, record_id, action, diff, at)
       SELECT id, 'person', 'per_missing', 'update', '{"location":{}}', at FROM core_audit
       WHERE id LIKE 'aud_new%'`,
    ).run();
    await setUpDay();
    moveTo(0, 8);
    rowsRead = 0;
    recorded = [];
    const report = await runNotificationDelivery({
      db: meteredDb.query,
      now: now(),
      appOrigin: null,
      callIntegration: fakeCall,
    });
    expect(report.digests.length).toBeGreaterThan(0);
    // The day's scan (500 audit + 1,000 change rows) once, plus a few dozen per person (about
    // 1,700 here), however many old audit rows and other people's overdue tasks there are.
    expect(rowsRead).toBeLessThan(2_000);
    expect(recorded.filter((r) => r.sql.includes("core_audit_at_idx"))).toHaveLength(1);
    expect(await scans()).toEqual([]);
    // Outside the digest window a tick reads three settings rows.
    rowsRead = 0;
    recorded = [];
    await runNotificationDelivery({
      db: meteredDb.query,
      now: new Date(clock + MINUTE),
      appOrigin: null,
      callIntegration: fakeCall,
    });
    expect(rowsRead).toBeLessThan(10);
  });
});
