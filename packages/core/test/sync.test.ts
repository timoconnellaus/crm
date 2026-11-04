// Email and calendar sync (stage 6 AC3, ADR 0052, ADR 0112): matching, dedupe across mailboxes,
// threading, deletes, each sharing level, mark-private, suggestion thresholds, job-change
// signals, sync events, and the rows-read budget of one batch.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@crm/db";
import { seedDatabase } from "@crm/db/seed";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, newId, type SyncItem } from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

type IngestOut = {
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  bodies: { key: string; activityId: string }[];
  removedBodies: string[];
};

let admin: ActingUser;
let alice: ActingUser;
let bob: ActingUser;
let internal: string;
let ext: string;
let adaEmail: string;
let adaName: string;
let ada: { id: string };
let org: { id: string };

async function connection(owner: ActingUser, sharing: "full" | "metadata" | "none") {
  const id = newId("connection");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, sharing_level, status, created_at, updated_at) VALUES (?, 'fake', 'personal', ?, 'Mail', ?, 'active', ?, ?)",
  )
    .bind(id, owner.id, sharing, now, now)
    .run();
  return id;
}

function ingest(owner: ActingUser, connectionId: string, items: SyncItem[], database = db) {
  return invokeByName(
    "sync.ingest",
    { connectionId, items },
    {
      actor: "automation",
      user: owner,
      origin: { surface: "automation", automationId: `sync:${connectionId}` },
      db: database,
    },
  ) as Promise<IngestOut>;
}

let seq = 0;
function mail(overrides: Partial<Extract<SyncItem, { kind: "email"; op: "upsert" }>> = {}) {
  seq += 1;
  const messageId = overrides.messageId ?? `m${seq}.${unique("x")}@mail.test`;
  return {
    kind: "email" as const,
    op: "upsert" as const,
    providerId: `p-${messageId}`,
    messageId,
    threadKey: `thread:${messageId}`,
    subject: `Subject ${seq}`,
    snippet: `Body text ${seq}`,
    hasBody: true,
    from: { email: adaEmail, name: "Ada Lovelace" },
    to: [{ email: `alice@${internal}` }],
    cc: [],
    sentAt: new Date(Date.UTC(2026, 9, 1, 10, seq % 60)).toISOString(),
    ...overrides,
  };
}

async function activityByKey(messageId: string) {
  return env.DB.prepare("SELECT * FROM core_activity WHERE external_key = ?")
    .bind(`email:${messageId}`)
    .first<Record<string, string | null>>();
}

async function suggestions(domain: string) {
  const out = (await invokeByName("suggestedContact.list", {}, context(admin))) as {
    groups: { domain: string; contacts: { email: string; messageCount: number }[] }[];
  };
  return out.groups.find((g) => g.domain === domain)?.contacts ?? [];
}

beforeAll(async () => {
  admin = await createUser("admin");
  alice = await createUser("member");
  bob = await createUser("member");
});

beforeEach(async () => {
  internal = `${unique("acme")}.test`;
  ext = `${unique("ext")}.org`;
  adaEmail = `ada@${ext}`;
  adaName = `Ada ${unique("L")}`;
  await invokeByName("sync.setSettings", { internalDomains: [internal] }, context(admin));
  org = (await invokeByName(
    "organisation.create",
    { name: "Ext", domains: [{ domain: ext }] },
    context(admin),
  )) as { id: string };
  ada = (await invokeByName(
    "person.create",
    { displayName: adaName, emails: [{ email: adaEmail }] },
    context(admin),
  )) as { id: string };
});

describe("matching and writing", () => {
  it("links people by address and organisations by domain, never internal ones", async () => {
    const conn = await connection(alice, "full");
    const known = mail();
    const internalOnly = mail({
      from: { email: `bob@${internal}` },
      to: [{ email: `alice@${internal}` }],
    });
    const out = await ingest(alice, conn, [known, internalOnly]);
    expect(out).toMatchObject({ created: 1, skipped: 1 });
    const row = await activityByKey(known.messageId);
    expect(row).toMatchObject({ type: "email", author_user_id: alice.id, disclosure: "full" });
    const links = await env.DB.prepare(
      "SELECT object_type, record_id FROM core_activity_links WHERE activity_id = ? ORDER BY object_type",
    )
      .bind(row?.id)
      .all();
    expect(links.results).toEqual([
      { object_type: "organisation", record_id: org.id },
      { object_type: "person", record_id: ada.id },
    ]);
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
      direction: "inbound",
      messageId: known.messageId,
    });
    expect(await activityByKey(internalOnly.messageId)).toBeNull();

    // A sync event for stage 5.
    const events = (await invokeByName(
      "integrationEvent.list",
      { source: "sync", connectionId: conn },
      context(admin),
    )) as { items: { type: string; payload: { activityId: string; personIds: string[] } }[] };
    expect(events.items.map((e) => e.type)).toEqual(["email.received"]);
    expect(events.items[0]?.payload).toMatchObject({ activityId: row?.id, personIds: [ada.id] });
    // The audit row is per batch, with counts and without content.
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'sync.ingest' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(alice.id)
      .first<{ input: string; result: string }>();
    expect(JSON.parse(audit?.result ?? "{}")).toMatchObject({ created: 1, skipped: 1 });
    expect(audit?.input).not.toContain("Body text");
  });

  it("dedupes one message across mailboxes and propagates deletes when the last copy goes", async () => {
    const a = await connection(alice, "full");
    const b = await connection(bob, "full");
    const shared = mail({ to: [{ email: `alice@${internal}` }, { email: `bob@${internal}` }] });
    const first = await ingest(alice, a, [shared]);
    const second = await ingest(bob, b, [{ ...shared, providerId: "bob-copy" }]);
    expect(first.created).toBe(1);
    expect(second).toMatchObject({ created: 0, updated: 1 });
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_activity WHERE external_key = ?",
    )
      .bind(`email:${shared.messageId}`)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(1);

    const gone = await ingest(alice, a, [
      { kind: "email", op: "delete", providerId: shared.providerId },
    ]);
    expect(gone.deleted).toBe(0);
    expect((await activityByKey(shared.messageId))?.deleted_at).toBeNull();
    const last = await ingest(bob, b, [{ kind: "email", op: "delete", providerId: "bob-copy" }]);
    expect(last.deleted).toBe(1);
    expect(last.removedBodies).toHaveLength(1);
    expect((await activityByKey(shared.messageId))?.deleted_at).not.toBeNull();
  });

  it("threads replies by their root Message-ID", async () => {
    const conn = await connection(alice, "metadata");
    const root = mail();
    const reply = mail({ threadKey: `thread:${root.messageId}` });
    await ingest(alice, conn, [root, reply]);
    expect((await activityByKey(reply.messageId))?.thread_key).toBe(`thread:${root.messageId}`);
    expect((await activityByKey(root.messageId))?.thread_key).toBe(`thread:${root.messageId}`);
  });

  it("syncs meetings, updates them and removes cancelled ones", async () => {
    const conn = await connection(alice, "full");
    const uid = `${unique("evt")}@cal.test`;
    const meeting = {
      kind: "meeting" as const,
      op: "upsert" as const,
      providerId: `evt-${uid}`,
      uid,
      title: "Kick-off",
      description: "Agenda",
      startsAt: "2026-10-02T09:00:00.000Z",
      endsAt: "2026-10-02T10:00:00.000Z",
      attendees: [{ email: adaEmail, name: "Ada" }, { email: `alice@${internal}` }],
    };
    expect((await ingest(alice, conn, [meeting])).created).toBe(1);
    const key = `ical:${uid}`;
    const row = await env.DB.prepare("SELECT * FROM core_activity WHERE external_key = ?")
      .bind(key)
      .first<Record<string, string>>();
    expect(row).toMatchObject({ type: "meeting", subject: "Kick-off", body: "Agenda" });
    expect(JSON.parse(row?.payload ?? "{}").attendees[0]).toMatchObject({ personId: ada.id });
    await ingest(alice, conn, [{ ...meeting, title: "Kick-off (moved)" }]);
    expect(
      (
        await env.DB.prepare("SELECT subject FROM core_activity WHERE external_key = ?")
          .bind(key)
          .first()
      )?.subject,
    ).toBe("Kick-off (moved)");
    expect((await ingest(alice, conn, [{ ...meeting, cancelled: true }])).deleted).toBe(1);
    // The activity is still a valid meeting for activity.update (strict payload).
    await expect(
      invokeByName("activity.restore", { id: row?.id }, context(alice)),
    ).resolves.toMatchObject({ type: "meeting" });
  });
});

describe("sharing levels", () => {
  it("full shares a snippet in D1 and the body in blob storage", async () => {
    const conn = await connection(alice, "full");
    const m = mail();
    const out = await ingest(alice, conn, [m]);
    const row = await activityByKey(m.messageId);
    expect(row).toMatchObject({ body: m.snippet, disclosure: "full" });
    expect(out.bodies).toEqual([
      { externalKey: `email:${m.messageId}`, activityId: row?.id, key: row?.body_ref },
    ]);
  });

  it("metadata shares subject, participants and time but no content", async () => {
    const conn = await connection(alice, "metadata");
    const m = mail();
    const out = await ingest(alice, conn, [m]);
    const row = await activityByKey(m.messageId);
    expect(row).toMatchObject({
      body: null,
      body_ref: null,
      disclosure: "metadata",
      subject: m.subject,
    });
    expect(out.bodies).toEqual([]);
    const search = await env.DB.prepare(
      "SELECT body FROM core_search_docs WHERE object_type = 'activity' AND record_id = ?",
    )
      .bind(row?.id)
      .first<{ body: string }>();
    expect(search?.body).toBe("");
    // A mailbox sharing full content later upgrades it.
    const full = await connection(bob, "full");
    const upgraded = await ingest(bob, full, [{ ...m, providerId: "other" }]);
    expect(upgraded.bodies).toHaveLength(1);
    expect((await activityByKey(m.messageId))?.disclosure).toBe("full");
  });

  it("don't sync writes nothing, not even suggestions", async () => {
    const conn = await connection(alice, "none");
    const stranger = `zed@${unique("none")}.com`;
    const m = mail({ from: { email: stranger } });
    const out = await ingest(alice, conn, [mail(), m]);
    expect(out).toMatchObject({ created: 0, skipped: 2 });
    const items = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_sync_item WHERE connection_id = ?",
    )
      .bind(conn)
      .first<{ n: number }>();
    expect(items?.n).toBe(0);
    expect(
      await env.DB.prepare("SELECT * FROM core_suggested_contact WHERE email = ?")
        .bind(stranger)
        .first(),
    ).toBeNull();
  });
});

describe("mark private", () => {
  it("hides a synced activity from everyone but its owner, including search", async () => {
    const conn = await connection(alice, "full");
    const m = mail({ subject: `Secret ${unique("plan")}` });
    await ingest(alice, conn, [m]);
    const id = (await activityByKey(m.messageId))?.id ?? "";
    const timeline = (user: ActingUser) =>
      invokeByName(
        "activity.listForRecord",
        { object: "person", recordId: ada.id },
        context(user),
      ) as Promise<{ items: { id: string; private?: boolean }[] }>;
    expect((await timeline(bob)).items.map((a) => a.id)).toContain(id);

    await expect(
      invokeByName("activity.setPrivate", { id, private: true }, context(bob)),
    ).rejects.toThrow(/owner/);
    await invokeByName("activity.setPrivate", { id, private: true }, context(alice));
    expect((await timeline(bob)).items.map((a) => a.id)).not.toContain(id);
    expect((await timeline(alice)).items.find((a) => a.id === id)?.private).toBe(true);
    await expect(invokeByName("activity.get", { id }, context(bob))).rejects.toThrow(/No activity/);
    const docs = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_search_docs WHERE object_type = 'activity' AND record_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(docs?.n).toBe(0);
    const view = await env.DB.prepare("SELECT count(*) AS n FROM crm_activities WHERE id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(view?.n).toBe(0);
    await invokeByName("activity.setPrivate", { id, private: false }, context(alice));
    expect((await timeline(bob)).items.map((a) => a.id)).toContain(id);
  });
});

describe("suggested contacts", () => {
  it("suggests external senders seen in at least two distinct messages, grouped by domain", async () => {
    const a = await connection(alice, "metadata");
    const b = await connection(bob, "metadata");
    const domain = `${unique("prospect")}.io`;
    const zed = `zed@${domain}`;
    const one = mail({ from: { email: zed, name: "Zed" } });
    await ingest(alice, a, [one]);
    expect(await suggestions(domain)).toEqual([]);
    // The same message in another mailbox, or synced again, does not count twice.
    await ingest(bob, b, [{ ...one, providerId: "copy" }]);
    await ingest(alice, a, [one]);
    expect(await suggestions(domain)).toEqual([]);
    // Automated senders and internal colleagues are never suggested.
    await ingest(alice, a, [
      mail({ from: { email: zed, name: "Zed" }, cc: [{ email: `no-reply@${domain}` }] }),
      mail({ from: { email: `no-reply@${domain}` } }),
    ]);
    expect(await suggestions(domain)).toEqual([
      expect.objectContaining({ email: zed, messageCount: 2 }),
    ]);

    const added = (await invokeByName(
      "suggestedContact.add",
      { emails: [zed], createOrganisation: true },
      context(alice),
    )) as { added: { personId: string }[]; organisationIds: string[] };
    expect(added.added).toHaveLength(1);
    expect(added.organisationIds).toHaveLength(1);
    expect(await suggestions(domain)).toEqual([]);
    // From now on the person matches and their mail is written.
    expect((await ingest(alice, a, [mail({ from: { email: zed } })])).created).toBe(1);
  });

  it("dismisses a whole domain", async () => {
    const conn = await connection(alice, "metadata");
    const domain = `${unique("spam")}.io`;
    await ingest(alice, conn, [
      mail({ from: { email: `x@${domain}` } }),
      mail({ from: { email: `x@${domain}` } }),
    ]);
    expect(await suggestions(domain)).toHaveLength(1);
    await invokeByName("suggestedContact.dismiss", { domain }, context(alice));
    expect(await suggestions(domain)).toEqual([]);
  });
});

describe("job-change signals", () => {
  async function jobChanges(personId: string) {
    const out = (await invokeByName("jobChange.list", {}, context(admin))) as {
      items: { id: string; personId: string; signal: string; proposal: Record<string, unknown> }[];
    };
    return out.items.filter((i) => i.personId === personId);
  }

  it("suggests a job change from a bounce, applied with person.changeJob", async () => {
    const conn = await connection(alice, "metadata");
    await ingest(alice, conn, [
      mail({
        from: { email: `mailer-daemon@${unique("mx")}.net` },
        subject: "Undeliverable",
        bounce: { failedRecipients: [adaEmail] },
      }),
    ]);
    const [suggestion] = await jobChanges(ada.id);
    expect(suggestion).toMatchObject({ signal: "bounce" });
    await expect(
      invokeByName("jobChange.apply", { id: suggestion?.id }, context(alice)),
    ).rejects.toThrow(/Which organisation/);
    const newco = (await invokeByName(
      "organisation.create",
      { name: "NewCo", domains: [{ domain: `${unique("newco")}.com` }] },
      context(admin),
    )) as { id: string };
    const applied = (await invokeByName(
      "jobChange.apply",
      { id: suggestion?.id, organisationId: newco.id, title: "CTO" },
      context(alice),
    )) as { result: { started: { organisationId: string } } };
    expect(applied.result.started.organisationId).toBe(newco.id);
    expect(await jobChanges(ada.id)).toEqual([]);
  });

  it("suggests a job change from a new signature and from a new domain", async () => {
    await invokeByName(
      "affiliation.create",
      { personId: ada.id, organisationId: org.id, title: "Engineer", primary: true },
      context(admin),
    );
    const conn = await connection(alice, "metadata");
    await ingest(alice, conn, [mail({ signature: "Ada Lovelace\nEngineer\nExt" })]);
    expect(await jobChanges(ada.id)).toEqual([]);
    await ingest(alice, conn, [mail({ signature: "Ada Lovelace\nCTO\nAnalytical Engines Ltd" })]);
    expect(await jobChanges(ada.id)).toEqual([
      expect.objectContaining({
        signal: "signature",
        proposal: expect.objectContaining({
          organisationName: "Analytical Engines Ltd",
          title: "CTO",
        }),
      }),
    ]);

    const newDomain = `${unique("engines")}.com`;
    await ingest(alice, conn, [mail({ from: { email: `ada@${newDomain}`, name: adaName } })]);
    const signals = (await jobChanges(ada.id)).map((s) => s.signal).sort();
    expect(signals).toEqual(["domain", "signature"]);
  });
});

describe("rows read", () => {
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

  it("a 50-message batch stays on indexes, whatever the table sizes", async () => {
    await seedDatabase(env.DB, { people: 2000, organisations: 400, activities: 400, tasks: 0 });
    const conn = await connection(alice, "full");
    const warm = Array.from({ length: 50 }, () => mail());
    await ingest(alice, conn, warm);
    rowsRead = 0;
    const batch = Array.from({ length: 50 }, (_, i) =>
      i % 2 ? mail() : mail({ from: { email: `p${i}@${unique("d")}.org`, name: `P ${i}` } }),
    );
    await ingest(alice, conn, batch, createCrmDb(metered));
    // Lookups by email, domain, external key and provider id, plus settings and the connection.
    expect(rowsRead).toBeLessThan(1500);
  }, 120_000);
});
