// Notification delivery (stage 6 AC6, ADR 0172) against real D1 with a fake transport: the
// preference and admin settings operations (scoped to the caller, admin-only, audited), delivery
// per preference over email and Slack, exactly once across repeated ticks, pending and failed
// sends, private activities that never leave the CRM, escalation of unread approvals, the daily
// digest, channel route matching, and that every query keeps to its index.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@crm/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CallIntegration,
  type DigestInput,
  deliverRouteMatches,
  invoke,
  invokeByName,
  matchNotificationRoutes,
  type NotificationRoute,
  newId,
  notifyStatements,
  parseDeliverySettings,
  plainDigest,
  purgeNotificationDeliveries,
  type RecordEventMessage,
  runNotificationDelivery,
} from "../src/index.ts";
import { context, createUser, db, setPreset } from "./helpers.ts";

// A synthetic clock, always moving forward: the delivery cursors are one row for the whole file.
let clock = Date.parse("2031-01-01T00:00:00.000Z");
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock += ms;
  return now();
};
const SECOND = 1000;
const MINUTE = 60 * SECOND;

type Call = Parameters<CallIntegration>[0];
/** The text of a send, post or DM call. */
const textOf = (call: Call | undefined): string =>
  String((call?.args[0] as { text?: unknown } | undefined)?.text ?? "");
const calls: Call[] = [];
let mode: "sent" | "pending" | "fail" = "sent";
const fakeCall: CallIntegration = async (input) => {
  calls.push(input);
  if (mode === "fail") throw new Error("Slack is down");
  return mode === "pending"
    ? { value: { status: "pending", id: calls.length }, pending: [{ actionId: "x" }], applied: [] }
    : { value: { status: "sent", id: calls.length }, pending: [], applied: [{ action: 1 }] };
};

function tick(
  at: Date = now(),
  extra: Partial<Parameters<typeof runNotificationDelivery>[0]> = {},
) {
  return runNotificationDelivery({
    db: db.query,
    now: at,
    appOrigin: "https://crm.test",
    callIntegration: fakeCall,
    ...extra,
  });
}

function ctx(user: ActingUser, extra: Record<string, unknown> = {}) {
  return context(user, { clock: now, ...extra });
}

async function notify(
  userId: string,
  title: string,
  options: { type?: "system.message" | "automation.message"; link?: unknown } = {},
) {
  const plan = await notifyStatements(
    db.query,
    {
      to: [{ userId }],
      type: options.type ?? "system.message",
      title,
      body: "Body text",
      link: (options.link ?? null) as never,
      source: { actor: "human", userId },
    },
    now().toISOString(),
  );
  await db.batch(plan.statements);
  const row = await env.DB.prepare(
    "SELECT id FROM core_notifications WHERE user_id = ? AND title = ?",
  )
    .bind(userId, title)
    .first<{ id: string }>();
  return row?.id as string;
}

async function ledger(key: string) {
  return env.DB.prepare(
    "SELECT status, detail, kind, channel FROM core_notification_delivery WHERE key = ?",
  )
    .bind(key)
    .first<{ status: string; detail: string | null; kind: string; channel: string }>();
}

async function connection(
  owner: ActingUser,
  vendor: string,
  pattern: string,
  url: string,
  scope: "org" | "personal" = "org",
) {
  const id = newId("connection");
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
  )
    .bind(
      id,
      vendor,
      scope,
      owner.id,
      vendor,
      JSON.stringify([{ key: "k1", url, pattern, title: vendor, tsType: "X", bindingName: "X" }]),
      at,
      at,
    )
    .run();
  return id;
}

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;
let emailConnection: string;
let slackConnection: string;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
  emailConnection = await connection(
    admin,
    "email-send",
    "email-send://sender/:address",
    "email-send://sender/crm%40example.com",
  );
  slackConnection = await connection(
    admin,
    "slack",
    "slack-post://workspace/:teamId",
    "slack-post://workspace/T1",
  );
});

describe("preferences and admin settings (operations)", () => {
  it("defaults to in-app only, merges changes per type and is scoped to the caller", async () => {
    const initial = await invoke("notification.preferences", {}, ctx(member));
    expect(initial.digest).toBe(false);
    expect(initial.available).toEqual({ email: false, slack: false });
    expect(initial.types.find((t) => t.type === "approval.pending")).toMatchObject({
      label: "Approvals waiting",
      channels: [],
    });
    await invoke(
      "notification.setPreferences",
      {
        channels: { "system.message": ["email", "slack", "email"], "approval.decided": ["slack"] },
      },
      ctx(member),
    );
    const next = await invoke(
      "notification.setPreferences",
      { channels: { "approval.decided": [] }, digest: true },
      ctx(member),
    );
    expect(next.digest).toBe(true);
    expect(next.types.find((t) => t.type === "system.message")?.channels).toEqual([
      "email",
      "slack",
    ]);
    expect(next.types.find((t) => t.type === "approval.decided")?.channels).toEqual([]);
    // Someone else's preferences are untouched.
    expect((await invoke("notification.preferences", {}, ctx(viewer))).digest).toBe(false);
    // People only: an MCP client cannot change them for its user.
    await expect(
      invokeByName(
        "notification.setPreferences",
        { digest: false },
        ctx(member, { actor: "mcp", origin: { surface: "mcp", sessionId: "cap_x" } }),
      ),
    ).rejects.toThrow();
  });

  it("admin settings refuse members, viewers and non-human actors", async () => {
    for (const name of [
      "notification.deliverySettings",
      "notification.updateDeliverySettings",
      "notification.routes",
      "notification.setRoutes",
    ]) {
      const input = name === "notification.setRoutes" ? { routes: [] } : {};
      await expect(invokeByName(name, input, ctx(member))).rejects.toThrow(
        /permission|role|admins/i,
      );
      await expect(invokeByName(name, input, ctx(viewer))).rejects.toThrow(
        /permission|role|admins/i,
      );
      await expect(
        invokeByName(name, input, ctx(admin, { actor: "mcp", origin: { surface: "mcp" } })),
      ).rejects.toThrow();
      await expect(
        invokeByName(
          name,
          input,
          ctx(admin, { actor: "automation", origin: { surface: "automation" } }),
        ),
      ).rejects.toThrow();
    }
  });

  it("validates connections, records an audit row and starts delivery from now", async () => {
    const personal = await connection(
      admin,
      "email-send",
      "email-send://sender/:address",
      "email-send://sender/me%40example.com",
      "personal",
    );
    await expect(
      invoke("notification.updateDeliverySettings", { email: personal }, ctx(admin)),
    ).rejects.toThrow(/org connections/);
    await expect(
      invoke("notification.updateDeliverySettings", { email: slackConnection }, ctx(admin)),
    ).rejects.toThrow(/Email sending/);
    await expect(
      invoke("notification.updateDeliverySettings", { escalationMinutes: 3 }, ctx(admin)),
    ).rejects.toThrow();
    const updated = await invoke(
      "notification.updateDeliverySettings",
      {
        email: emailConnection,
        slack: slackConnection,
        escalationMinutes: 10,
        escalationChannels: ["slack"],
        digestHour: 8,
      },
      ctx(admin),
    );
    expect(updated).toEqual({
      email: emailConnection,
      slack: slackConnection,
      escalationMinutes: 10,
      escalationChannels: ["slack"],
      digestHour: 8,
    });
    const read = await invoke("notification.deliverySettings", {}, ctx(admin));
    expect(read).toMatchObject({ email: emailConnection, problems: [] });
    const audit = await env.DB.prepare(
      "SELECT outcome FROM core_audit WHERE operation = 'notification.updateDeliverySettings' AND user_id = ? AND outcome = 'ok'",
    )
      .bind(admin.id)
      .all();
    expect(audit.results).toHaveLength(1);
    const state = await env.DB.prepare(
      "SELECT value FROM core_settings WHERE key = 'notification_delivery_state'",
    ).first<{ value: string }>();
    expect(JSON.parse(state?.value ?? "{}").notify.at).toBe(now().toISOString());
    expect((await invoke("notification.preferences", {}, ctx(member))).available).toEqual({
      email: true,
      slack: true,
    });
  });

  it("validates and normalises routes; activities can never be routed", async () => {
    await expect(
      invoke(
        "notification.setRoutes",
        {
          routes: [
            { label: "Mail", object: "activity", event: "created", channel: "#x", enabled: true },
          ],
        },
        ctx(admin),
      ),
    ).rejects.toThrow(/never posted/);
    await expect(
      invoke(
        "notification.setRoutes",
        {
          routes: [{ label: "X", object: "nope", event: "created", channel: "#x", enabled: true }],
        },
        ctx(admin),
      ),
    ).rejects.toThrow(/Unknown object/);
    await expect(
      invoke(
        "notification.setRoutes",
        {
          routes: [
            {
              label: "X",
              object: "person",
              event: "created",
              field: "jobTitle",
              channel: "#x",
              enabled: true,
            },
          ],
        },
        ctx(admin),
      ),
    ).rejects.toThrow(/updated event/);
    const saved = await invoke(
      "notification.setRoutes",
      {
        routes: [
          {
            label: "New person",
            object: "person",
            event: "created",
            channel: "#people",
            enabled: true,
          },
        ],
      },
      ctx(admin),
    );
    expect(saved.routes[0]?.id).toMatch(/^nrt_/);
    expect((await invoke("notification.routes", {}, ctx(admin))).routes).toEqual(saved.routes);
  });

  it("falls back to nothing configured on a broken settings value", () => {
    expect(parseDeliverySettings("not json")).toMatchObject({ email: null, slack: null });
    expect(parseDeliverySettings('{"email":7}')).toMatchObject({ email: null, slack: null });
  });
});

describe("delivery per preference", () => {
  it("sends by email and Slack DM as each person chose, once, with an absolute link", async () => {
    advance(MINUTE);
    const personId = (await invoke("person.create", { givenName: "Grace" }, ctx(admin))).id;
    const forMember = await notify(member.id, "Grace needs you", {
      link: { kind: "record", object: "person", id: personId },
    });
    const forAdmin = await notify(admin.id, "Admin only in-app");
    calls.length = 0;
    // Within the 30 s lag nothing goes out yet.
    expect((await tick(advance(10 * SECOND))).notifications).toEqual([]);
    const report = await tick(advance(25 * SECOND));
    expect(report.notifications.map((r) => [r.key, r.status])).toEqual([
      [`n:${forMember}:email`, "sent"],
      [`n:${forMember}:slack`, "sent"],
    ]);
    expect(calls).toHaveLength(2);
    const [email, slack] = calls;
    expect(email).toMatchObject({ connectionId: emailConnection, resource: "k1", method: "send" });
    expect(email?.args[0]).toEqual({
      to: [member.email],
      subject: "[CRM] Grace needs you",
      text: `Grace needs you\n\nBody text\n\nOpen in the CRM: https://crm.test/people/${personId}`,
    });
    expect(slack).toMatchObject({ connectionId: slackConnection, method: "dm" });
    expect(slack?.args[0]).toMatchObject({ user: member.email });
    expect(String(textOf(slack))).toContain(
      `<https://crm.test/people/${personId}|Open in the CRM>`,
    );
    expect(await ledger(`n:${forAdmin}:email`)).toBeNull();
    // Repeated ticks send nothing again.
    await tick(advance(SECOND));
    await tick(advance(MINUTE));
    expect(calls).toHaveLength(2);
    expect(await ledger(`n:${forMember}:email`)).toMatchObject({
      status: "sent",
      kind: "notification",
    });
  });

  it("records a send waiting for approval as pending and a failure as failed; the in-app row stays", async () => {
    mode = "pending";
    const pending = await notify(member.id, "Waits for approval");
    await tick(advance(31 * SECOND));
    expect(await ledger(`n:${pending}:email`)).toMatchObject({ status: "pending" });
    mode = "fail";
    const failed = await notify(member.id, "Transport fails");
    await tick(advance(31 * SECOND));
    expect(await ledger(`n:${failed}:slack`)).toMatchObject({
      status: "failed",
      detail: "Slack is down",
    });
    mode = "sent";
    const row = await env.DB.prepare("SELECT read_at FROM core_notifications WHERE id = ?")
      .bind(failed)
      .first();
    expect(row).toEqual({ read_at: null });
    // A failed send is not retried by later ticks (exactly once means at most once).
    calls.length = 0;
    await tick(advance(MINUTE));
    expect(calls).toEqual([]);
  });

  it("never sends a notice that links to a private activity", async () => {
    const person = await invoke("person.create", { givenName: "Ada" }, ctx(member));
    const note = await invoke(
      "activity.log",
      { type: "note", body: "Confidential", links: [{ object: "person", id: person.id }] },
      ctx(member),
    );
    await env.DB.prepare("UPDATE core_activity SET private_to = ? WHERE id = ?")
      .bind(member.id, note.id)
      .run();
    const id = await notify(member.id, "Email from the board", {
      link: { kind: "record", object: "activity", id: note.id },
    });
    calls.length = 0;
    await tick(advance(31 * SECOND));
    expect(calls).toEqual([]);
    expect(await ledger(`n:${id}:email`)).toMatchObject({ status: "skipped" });
  });
});

describe("escalation of unread approvals", () => {
  async function queueForMember(): Promise<{ notice: string; changeSetId: string }> {
    await setPreset("cautious");
    const mcp = ctx(member, {
      actor: "mcp",
      origin: { surface: "mcp", sessionId: `cap_${newId("user")}`, clientName: "Agent" },
    });
    let changeSetId = "";
    try {
      await invoke("person.create", { givenName: "Queued" }, mcp);
    } catch (error) {
      changeSetId = (error as { pending?: { changeSetId: string } }).pending?.changeSetId ?? "";
    }
    expect(changeSetId).toMatch(/^chs_/);
    const row = await env.DB.prepare(
      "SELECT id FROM core_notifications WHERE user_id = ? AND type = 'approval.pending' AND dedupe_key = ?",
    )
      .bind(member.id, `approval:${changeSetId}`)
      .first<{ id: string }>();
    return { notice: row?.id as string, changeSetId };
  }

  it("escalates an unread approval once after the delay, on the escalation channels", async () => {
    const { notice } = await queueForMember();
    calls.length = 0;
    await tick(advance(31 * SECOND));
    expect(calls).toEqual([]); // the member did not choose approval.pending by preference
    expect((await tick(advance(5 * MINUTE))).escalations).toEqual([]);
    const report = await tick(advance(5 * MINUTE));
    expect(report.escalations).toEqual([{ key: `esc:${notice}:slack`, status: "sent" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "dm", connectionId: slackConnection });
    expect(String(textOf(calls[0]))).toMatch(/Reminder: Agent is waiting/);
    await tick(advance(MINUTE));
    await tick(advance(10 * MINUTE));
    expect(calls).toHaveLength(1);
  });

  it("does not escalate a notice that was read, decided, or already sent by preference", async () => {
    const read = await queueForMember();
    await invoke("notification.markRead", { ids: [read.notice] }, ctx(member));
    const decided = await queueForMember();
    await invoke("approval.reject", { changeSetId: decided.changeSetId }, ctx(admin));
    await invoke(
      "notification.setPreferences",
      { channels: { "approval.pending": ["email"] } },
      ctx(member),
    );
    const preferred = await queueForMember();
    calls.length = 0;
    await tick(advance(31 * SECOND));
    expect(calls.map((c) => c.method)).toEqual(["send"]); // by preference, the third one only
    const report = await tick(advance(11 * MINUTE));
    expect(report.escalations).toEqual([]);
    expect(await ledger(`esc:${read.notice}:slack`)).toBeNull();
    expect(await ledger(`esc:${decided.notice}:slack`)).toBeNull();
    expect(await ledger(`esc:${preferred.notice}:slack`)).toBeNull();
    await invoke(
      "notification.setPreferences",
      { channels: { "approval.pending": [] } },
      ctx(member),
    );
  });
});

describe("the daily digest", () => {
  it("emails unread notices and pending approvals at the digest hour, once a day, by preference", async () => {
    // Move to 07:59 UTC (automation timezone default) of the next day.
    const day = new Date(clock);
    day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCHours(7, 59, 0, 0);
    clock = day.getTime();
    await invoke("notification.setPreferences", { digest: true }, ctx(viewer));
    const fresh = await notify(member.id, "Fresh for the digest");
    const privateNote = await env.DB.prepare(
      "SELECT id FROM core_activity WHERE private_to = ? LIMIT 1",
    )
      .bind(member.id)
      .first<{ id: string }>();
    await notify(member.id, "Private board email", {
      type: "automation.message",
      link: { kind: "record", object: "activity", id: privateNote?.id },
    });
    calls.length = 0;
    const early = await tick(now());
    expect(early.digests).toEqual([]);
    const inputs: DigestInput[] = [];
    const report = await tick(advance(MINUTE), {
      composeDigest: (input) => {
        inputs.push(input);
        return plainDigest(input);
      },
    });
    const date = now().toISOString().slice(0, 10);
    // The member asked for a digest; the admin did not; the viewer has nothing unread to see.
    expect(report.digests).toEqual([{ key: `digest:${date}:${member.id}`, status: "sent" }]);
    const input = inputs[0] as DigestInput;
    expect(input.items.map((i) => i.title)).toContain("Fresh for the digest");
    expect(input.items.map((i) => i.title)).not.toContain("Private board email");
    expect(input.pendingApprovals).toBeGreaterThan(0);
    const email = calls.find(
      (c) =>
        c.method === "send" &&
        (c.args[0] as { subject: string }).subject.startsWith("[CRM] Daily digest"),
    );
    expect(email?.args[0]).toMatchObject({ to: [member.email] });
    const text = textOf(email);
    expect(text).toContain(`Your CRM digest for ${date}`);
    expect(text).toContain("Fresh for the digest");
    expect(text).toContain("Review approvals: https://crm.test/approvals");
    expect(text).not.toContain("Private board email");
    expect(fresh).toBeTruthy();
    // Later ticks the same day send nothing more.
    const count = calls.length;
    await tick(advance(MINUTE));
    await tick(advance(3 * 60 * MINUTE));
    expect(calls.length).toBe(count);
  });

  it("turning the digest off stops it the next day", async () => {
    await invoke("notification.setPreferences", { digest: false }, ctx(member));
    const day = new Date(clock);
    day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCHours(8, 0, 0, 0);
    clock = day.getTime();
    await notify(member.id, "Next day");
    const report = await tick(advance(MINUTE));
    expect(report.digests).toEqual([]);
  });
});

describe("channel routes", () => {
  const route = (over: Partial<NotificationRoute> = {}): NotificationRoute => ({
    id: "nrt_a",
    label: "New person",
    object: "person",
    event: "created",
    channel: "#people",
    enabled: true,
    ...over,
  });
  const message = (over: Partial<RecordEventMessage> = {}): RecordEventMessage => ({
    v: 1,
    kind: "record",
    id: "aud_1:0",
    at: now().toISOString(),
    origin: {
      actor: "human",
      userId: "usr_x",
      surface: "ui",
      operation: "person.create",
      rootEventId: "aud_1",
      depth: 0,
      chain: [],
      bulk: false,
    },
    changes: [{ object: "person", id: "per_1", action: "created" }],
    ...over,
  });

  it("matches events and field changes, and skips bulk events, disabled routes and activities", () => {
    expect(matchNotificationRoutes(message(), [route()])).toHaveLength(1);
    expect(matchNotificationRoutes(message(), [route({ enabled: false })])).toEqual([]);
    expect(matchNotificationRoutes(message(), [route({ event: "deleted" })])).toEqual([]);
    expect(
      matchNotificationRoutes(message({ origin: { ...message().origin, bulk: true } }), [route()]),
    ).toEqual([]);
    expect(
      matchNotificationRoutes(
        message({ changes: [{ object: "activity", id: "act_1", action: "created" }] }),
        [route({ object: "activity" })],
      ),
    ).toEqual([]);
    const updated = message({
      changes: [
        {
          object: "person",
          id: "per_1",
          action: "updated",
          diff: { jobTitle: { before: "Engineer", after: "CTO" } },
        },
      ],
    });
    const titled = route({ event: "updated", field: "jobTitle", to: "CTO" });
    expect(matchNotificationRoutes(updated, [titled])).toHaveLength(1);
    expect(matchNotificationRoutes(updated, [{ ...titled, to: { in: ["CEO"] } }])).toEqual([]);
    expect(matchNotificationRoutes(updated, [{ ...titled, field: "givenName" }])).toEqual([]);
  });

  it("posts each match once with the record's title and link", async () => {
    const person = await invoke(
      "person.create",
      { givenName: "Linus", familyName: "T" },
      ctx(admin),
    );
    const matches = matchNotificationRoutes(
      message({ changes: [{ object: "person", id: person.id, action: "created" }] }),
      [route()],
    );
    calls.length = 0;
    const deliver = () =>
      deliverRouteMatches({
        db: db.query,
        matches,
        target: { connectionId: slackConnection, resource: "k1" },
        callIntegration: fakeCall,
        appOrigin: "https://crm.test",
        now: now().toISOString(),
      });
    expect(await deliver()).toEqual([{ key: `route:aud_1:0:nrt_a:${person.id}`, status: "sent" }]);
    expect(await deliver()).toEqual([
      { key: `route:aud_1:0:nrt_a:${person.id}`, status: "duplicate" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "post" });
    expect(calls[0]?.args[0]).toMatchObject({ channel: "#people" });
    expect(textOf(calls[0])).toMatch(
      new RegExp(
        `^\\*New person\\*: Person "Linus T"\\n<https://crm.test/people/${person.id}\\|Open in the CRM>$`,
      ),
    );
  });
});

// --- Cost: indexes, rows read --------------------------------------------------------------------

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
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const meteredDb = createCrmDb(metered);

/** Full scans of the delivery tables in the recorded statements' plans. */
async function scans(extra: string[] = []): Promise<string[]> {
  const tables = [
    ...extra,
    "core_notifications",
    "core_notification_delivery",
    "core_notification_preference",
    "core_pending_action",
    "core_user",
  ];
  const found: string[] = [];
  for (const { sql, params } of recorded) {
    if (!/^\s*(SELECT|DELETE|UPDATE|WITH)/i.test(sql)) continue;
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
  beforeAll(async () => {
    // 3,000 old notices (behind every cursor) and 3,000 old ledger rows.
    await env.DB.prepare(
      `INSERT INTO core_notifications (id, user_id, type, title, created_at, read_at)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 3000)
       SELECT printf('ntf_old%06d', i), ?, 'approval.pending', 'x',
         strftime('%Y-%m-%dT%H:%M:%fZ', '2030-01-01', '+' || i || ' minutes'), NULL FROM k`,
    )
      .bind(member.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_notification_delivery (key, kind, channel, user_id, status, created_at)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 3000)
       SELECT printf('n:ntf_old%06d:email', i), 'notification', 'email', ?, 'sent',
         '2030-01-02T00:00:00.000Z' FROM k`,
    )
      .bind(member.id)
      .run();
  });

  it("a tick reads about its new rows, through indexes, not the tables", async () => {
    await invoke(
      "notification.setPreferences",
      { channels: { "system.message": ["email"] }, digest: true },
      ctx(member),
    );
    for (let i = 0; i < 20; i++) await notify(member.id, `Cost ${i}`);
    rowsRead = 0;
    recorded = [];
    const report = await runNotificationDelivery({
      db: meteredDb.query,
      now: advance(31 * SECOND),
      appOrigin: "https://crm.test",
      callIntegration: fakeCall,
    });
    expect(report.notifications.filter((r) => r.status === "sent")).toHaveLength(20);
    expect(rowsRead).toBeLessThan(400);
    expect(await scans()).toEqual([]);
  });

  it("an idle tick reads a handful of rows", async () => {
    rowsRead = 0;
    recorded = [];
    await runNotificationDelivery({
      db: meteredDb.query,
      now: advance(MINUTE),
      appOrigin: null,
      callIntegration: fakeCall,
    });
    expect(rowsRead).toBeLessThan(40);
    expect(await scans()).toEqual([]);
  });

  it("the digest reads its people and their last day through the partial and user indexes", async () => {
    const day = new Date(clock);
    day.setUTCDate(day.getUTCDate() + 1);
    day.setUTCHours(9, 0, 0, 0);
    clock = day.getTime();
    await notify(member.id, "Digest cost");
    rowsRead = 0;
    recorded = [];
    const report = await runNotificationDelivery({
      db: meteredDb.query,
      now: now(),
      appOrigin: null,
      callIntegration: fakeCall,
    });
    expect(report.digests.map((d) => d.status)).toEqual(["sent"]);
    expect(rowsRead).toBeLessThan(600);
    expect(await scans()).toEqual([]);
  });

  it("a route match reads its settings, the ledger key and the record by primary key", async () => {
    const person = await invoke("person.create", { givenName: "Routed" }, ctx(admin));
    const matches = matchNotificationRoutes(
      {
        v: 1,
        kind: "record",
        id: "aud_cost:0",
        at: now().toISOString(),
        origin: {
          actor: "human",
          userId: admin.id,
          surface: "ui",
          operation: "person.create",
          rootEventId: "aud_cost",
          depth: 0,
          chain: [],
          bulk: false,
        },
        changes: [{ object: "person", id: person.id, action: "created" }],
      },
      (await invoke("notification.routes", {}, ctx(admin))).routes,
    );
    expect(matches).toHaveLength(1);
    rowsRead = 0;
    recorded = [];
    const results = await deliverRouteMatches({
      db: meteredDb.query,
      matches,
      target: { connectionId: slackConnection, resource: "k1" },
      callIntegration: fakeCall,
      appOrigin: null,
      now: now().toISOString(),
    });
    expect(results.map((r) => r.status)).toEqual(["sent"]);
    expect(rowsRead).toBeLessThan(30);
    expect(await scans(["core_person", "core_email"])).toEqual([]);
  });

  it("purges the ledger after 90 days in index-ordered chunks", async () => {
    const recent = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notification_delivery WHERE created_at >= '2030-06-01'",
    ).first<{ n: number }>();
    rowsRead = 0;
    recorded = [];
    const result = await purgeNotificationDeliveries(meteredDb.query, "2030-06-01T00:00:00.000Z", {
      chunk: 1000,
    });
    expect(result).toEqual({ deleted: 3000, more: false });
    expect(rowsRead).toBeLessThan(3000 * 8);
    expect(await scans()).toEqual([]);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notification_delivery",
    ).first<{ n: number }>();
    expect(left?.n).toBe(recent?.n);
  });
});
