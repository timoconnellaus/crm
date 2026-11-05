// Erase reaches every store (ADR 0320, amending ADR 0019): a person seeded across sync, R2 bodies,
// extension data, automation runs, notifications, integration events and the outbox is erased,
// and then nothing identifying them is left anywhere in D1 or blob storage (outside the audit
// columns ADR 0019 keeps on purpose). Also: the organisation equivalent, sync dropping an erased
// address on re-ingest, the erase log and its re-apply, and the per-store helpers.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type BlobStore,
  invoke,
  invokeByName,
  newId,
  type SyncItem,
} from "../src/index.ts";
import { redactJson } from "../src/records/erase-stores.ts";
import {
  aboutPattern,
  erasedAddressHash,
  normaliseTerms,
  subjectMatcher,
} from "../src/records/erase-subject.ts";
import { withoutErased } from "../src/sync/ingest.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let internal: string;

/** R2 in memory. */
function memoryBlobs(): BlobStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => {
      map.set(key, value);
    },
    delete: async (keys) => {
      for (const k of keys) map.delete(k);
    },
    list: async (prefix) => ({ keys: [...map.keys()].filter((k) => k.startsWith(prefix)) }),
  };
}

async function connection(owner: ActingUser) {
  const id = newId("connection");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, sharing_level, status, created_at, updated_at) VALUES (?, 'fake', 'personal', ?, 'Mail', 'full', 'active', ?, ?)",
  )
    .bind(id, owner.id, now, now)
    .run();
  return id;
}

type IngestOut = { created: number; bodies: { key: string }[] };
function ingest(owner: ActingUser, connectionId: string, items: SyncItem[]) {
  return invokeByName(
    "sync.ingest",
    { connectionId, items },
    {
      actor: "automation",
      user: owner,
      origin: { surface: "automation", automationId: `sync:${connectionId}` },
      db,
    },
  ) as Promise<IngestOut>;
}

let seq = 0;
function mail(
  from: { email: string; name?: string },
  to: { email: string; name?: string }[],
  extra: Partial<Extract<SyncItem, { kind: "email"; op: "upsert" }>> = {},
) {
  seq += 1;
  const messageId = `m${seq}.${unique("x")}@mail.test`;
  return {
    kind: "email" as const,
    op: "upsert" as const,
    providerId: `p-${messageId}`,
    messageId,
    subject: `Subject ${seq}`,
    snippet: `Snippet ${seq}`,
    hasBody: true,
    from,
    to,
    cc: [],
    sentAt: new Date(Date.UTC(2026, 9, 1, 10, seq % 60)).toISOString(),
    ...extra,
  };
}

const iso = () => new Date().toISOString();

/** Every row of every table, as text, that contains one of `needles` (case-insensitive). */
async function findAnywhere(
  needles: readonly string[],
  skip: (table: string, row: Record<string, unknown>) => Record<string, unknown> | null = (_t, r) =>
    r,
) {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'core_search%' AND name <> 'd1_migrations'",
  ).all<{ name: string }>();
  const hits: { table: string; needle: string; row: string }[] = [];
  const lower = needles.map((n) => n.toLowerCase());
  for (const { name } of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all<
      Record<string, unknown>
    >();
    for (const raw of results) {
      const row = skip(name, raw);
      if (!row) continue;
      const text = JSON.stringify(row).toLowerCase();
      for (const needle of lower) {
        if (text.includes(needle)) hits.push({ table: name, needle, row: text.slice(0, 300) });
      }
    }
  }
  return hits;
}

/** The audit columns ADR 0019 keeps: which record an audit or change row was about, and the
 * erase's own audit row (input `{ id }`, its result). */
function auditKept(table: string, row: Record<string, unknown>) {
  if (table === "core_audit_changes" || table === "core_audit_redactions") {
    const { record_id: _kept, ...rest } = row;
    return rest;
  }
  if (table === "core_audit" && String(row.operation).endsWith(".erase")) return null;
  return row;
}

let ext: string;
beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  internal = `${unique("home")}.test`;
  await invokeByName("sync.setSettings", { internalDomains: [internal] }, context(admin));
  // A generic extension: a field on people (side table), a link object whose required relation
  // is a person (like a deal participant), and a ticket with an optional relation and free text.
  ext = extId("er");
  await reconcile(
    manifest(ext, {
      fields: {
        person: { nickname: { type: "text", label: "Nickname" } },
        organisation: { motto: { type: "text", label: "Motto" } },
      },
      objects: {
        link: {
          label: "Link",
          plural: "Links",
          titleField: "role",
          fields: {
            role: { type: "text", label: "Role" },
            person: { type: "relation", label: "Person", to: "person", required: true },
            note: { type: "text", label: "Note" },
          },
        },
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "summary",
          fields: {
            summary: { type: "text", label: "Summary", required: true },
            contact: { type: "relation", label: "Contact", to: "person" },
            watchers: { type: "relation", label: "Watchers", to: "person", many: true },
            company: { type: "relation", label: "Company", to: "organisation" },
            contactEmail: { type: "email", label: "Contact email" },
            notes: { type: "longText", label: "Notes" },
          },
        },
      },
    }),
  );
});

describe("person.erase reaches every store", () => {
  it("leaves nothing identifying the person anywhere", async () => {
    const blobs = memoryBlobs();
    const given = unique("Zebulon");
    const family = unique("Quartermain");
    const display = `${given} ${family}`;
    const oldEmail = `${unique("old")}@former.example`;
    const email = `${unique("zq")}@zq-${unique("d")}.example`;
    const digits = `1555${String(Date.now()).slice(-7)}`;
    const phone = `+${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    const profile = `https://social.example/in/${unique("zq")}`;

    const person = await invoke(
      "person.create",
      {
        givenName: given,
        familyName: family,
        emails: [{ email: oldEmail }],
        phones: [{ number: phone }],
        socialProfiles: [{ network: "social", url: profile }],
      },
      context(member),
    );
    // The old address is replaced: only the audit log remembers it.
    await invoke("person.update", { id: person.id, emails: [{ email }] }, context(member));
    const bystander = await invoke(
      "person.create",
      { displayName: "Bystander", emails: [{ email: `${unique("by")}@bystander.example` }] },
      context(member),
    );
    const bystanderEmail = (
      await env.DB.prepare("SELECT email FROM core_person_emails WHERE person_id = ?")
        .bind(bystander.id)
        .first<{ email: string }>()
    )?.email as string;

    // Sync: an email only about them (owned) and one also about the bystander (shared), with
    // bodies in R2; a signature, a job-change suggestion, a suggested contact for the old address.
    const conn = await connection(member);
    const owned = mail({ email, name: display }, [{ email: `me@${internal}` }], {
      signature: `${display}\nChief Engineer\nZQ Ltd`,
    });
    const shared = mail({ email, name: display }, [
      { email: `me@${internal}` },
      { email: bystanderEmail },
    ]);
    const out = await ingest(member, conn, [owned, shared]);
    expect(out.created).toBe(2);
    for (const b of out.bodies) blobs.map.set(b.key, `Hi, this is ${display}, call ${phone}`);
    expect(blobs.map.size).toBe(2);
    await ingest(member, conn, [
      mail({ email, name: display }, [{ email: `me@${internal}` }], {
        signature: `${display}\nCTO\nOther Co`,
        hasBody: false,
      }),
    ]);
    const now = iso();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_suggested_contact (email, domain, name, message_count, first_seen_at, last_seen_at, status) VALUES (?, 'former.example', ?, 3, ?, ?, 'open')",
      ).bind(oldEmail, display, now, now),
      env.DB.prepare(
        "INSERT INTO core_job_change_suggestion (id, person_id, signal, dedupe_key, evidence, proposal, status, created_at) VALUES (?, ?, 'bounce', ?, ?, '{}', 'open', ?)",
      ).bind(
        newId("jobChange"),
        person.id,
        `bounce:${email}`,
        JSON.stringify({ email, subject: `To ${display}` }),
        now,
      ),
    ]);

    // Extension data: a side-table field, a link row, tickets (relation, many-relation, email
    // field, free text), key-value state and run logs.
    const linkId = newId("record");
    const ticketId = newId("record");
    const otherTicket = newId("record");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO x_${ext}_person (id, nickname) VALUES (?, ?)`).bind(
        person.id,
        `Zed ${family}`,
      ),
      env.DB.prepare(
        `INSERT INTO x_${ext}_link (id, created_at, updated_at, role, person, note) VALUES (?, ?, ?, 'Champion', ?, ?)`,
      ).bind(linkId, now, now, person.id, `${given} loves us`),
      env.DB.prepare(
        `INSERT INTO x_${ext}_ticket (id, created_at, updated_at, summary, contact, watchers, contact_email, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ticketId,
        now,
        now,
        `Printer broken for ${family}`,
        person.id,
        JSON.stringify([person.id, bystander.id]),
        email,
        `Call ${phone}`,
      ),
      env.DB.prepare(
        `INSERT INTO x_${ext}_ticket (id, created_at, updated_at, summary, contact_email, notes) VALUES (?, ?, ?, 'Unrelated', ?, ?)`,
      ).bind(otherTicket, now, now, email, `cc ${oldEmail}`),
      env.DB.prepare(
        "INSERT INTO core_search_docs (object_type, record_id, title, body) VALUES (?, ?, ?, '')",
      ).bind(`${ext}.link`, linkId, `Champion ${email}`),
      env.DB.prepare(
        "INSERT INTO core_extension_kv (extension_id, key, value, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
      ).bind(
        ext,
        `last:${person.id}`,
        '"x"',
        now,
        ext,
        "cache",
        JSON.stringify({ people: [person.id], note: `mailed ${email}` }),
        now,
      ),
      env.DB.prepare(
        "INSERT INTO core_extension_runs (id, extension_id, kind, name, started_at, duration_ms, outcome, error, logs, operations) VALUES (?, ?, 'tool', 'lookup', ?, 5, 'error', ?, ?, ?)",
      ).bind(
        newId("record"),
        ext,
        now,
        JSON.stringify({ code: "internal", message: `No ${email}` }),
        JSON.stringify([{ level: "info", message: `Looking up ${email}` }]),
        JSON.stringify([
          { operation: "person.get", records: [{ object: "person", id: person.id }] },
        ]),
      ),
    ]);

    // Automation runs: one about them (their record), one that only mentions them; run records;
    // notifications (one from the run, one linking to them, the daily digest); deliveries;
    // integration events; the outbox.
    const aboutRun = newId("record");
    const mentionRun = newId("record");
    const note = (id: string, title: string, body: string, link: string | null, runId?: string) =>
      env.DB.prepare(
        "INSERT INTO core_notifications (id, user_id, type, title, body, link, source, created_at) VALUES (?, ?, 'info', ?, ?, ?, ?, ?)",
      ).bind(
        id,
        member.id,
        title,
        body,
        link,
        JSON.stringify({ actor: "automation", ...(runId ? { runId } : {}) }),
        now,
      );
    const run = (id: string, record: string | null, trigger: unknown, steps: unknown) =>
      env.DB.prepare(
        "INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, record_object, record_id, status, status_reason, steps, report, error, started_at, updated_at) VALUES (?, 'aut_x', ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        ext,
        JSON.stringify(trigger),
        record ? "person" : null,
        record,
        `Failed for ${given}`,
        JSON.stringify(steps),
        JSON.stringify({ summary: `Wrote to ${display}` }),
        JSON.stringify({ code: "internal", message: `bad ${email}` }),
        now,
        now,
      );
    await env.DB.batch([
      run(
        aboutRun,
        person.id,
        { type: "record.updated", change: { emails: { before: oldEmail, after: email } } },
        [
          {
            name: "greet",
            kind: "do",
            status: "failed",
            startedAt: now,
            operations: [],
            logs: [{ level: "info", message: `Hello ${given}`, at: now }],
            value: { name: display },
          },
        ],
      ),
      run(mentionRun, null, { type: "schedule" }, [
        {
          name: "scan",
          kind: "do",
          status: "completed",
          startedAt: now,
          operations: [],
          logs: [
            { level: "info", message: `Saw ${email}`, at: now },
            { level: "info", message: "Unrelated line", at: now },
          ],
        },
      ]),
      env.DB.prepare(
        "INSERT INTO core_automation_run_records (object_type, record_id, run_id, role, at) VALUES ('person', ?, ?, 'trigger', ?)",
      ).bind(person.id, aboutRun, now),
      note(newId("record"), `Run finished for ${given}`, "Done", null, aboutRun),
      note(newId("record"), "Follow up", `Call ${display}`, `/people/${person.id}`),
      note(newId("record"), "Your day", `- [Call](/people/${person.id})\n- ${email}`, "/"),
      env.DB.prepare(
        "INSERT INTO core_notification_delivery (key, kind, channel, user_id, status, detail, created_at) VALUES (?, 'notification', 'email', ?, 'failed', ?, ?)",
      ).bind(unique("dk"), member.id, `Bounced: ${email}`, now),
      env.DB.prepare(
        "INSERT INTO core_integration_event (id, source, connection_id, type, payload, occurred_at, created_at) VALUES (?, 'webhook', ?, 'form.submitted', ?, ?, ?)",
      ).bind(
        newId("record"),
        conn,
        JSON.stringify({ email, name: "kept", personIds: [person.id, bystander.id] }),
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO core_automation_outbox (id, messages, next_at, created_at) VALUES (?, ?, ?, ?)",
      ).bind(
        newId("record"),
        JSON.stringify([{ record: { object: "person", id: person.id } }, { record: { id: "x" } }]),
        now,
        now,
      ),
    ]);

    const result = await invoke("person.erase", { id: person.id }, context(admin, { blobs }));
    expect(result).toMatchObject({
      suggestionsRemoved: 1,
      notificationsDeleted: 3,
      runsRedacted: 2,
      bodiesDeleted: 2,
    });
    expect(result.extensionRowsErased).toBeGreaterThanOrEqual(4);

    // R2: both bodies are gone, the queue is empty, and the erase log holds only hashes.
    expect([...blobs.map.keys()].filter((k) => k.startsWith("email-bodies/"))).toEqual([]);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM core_blob_deletion").first<{ n: number }>(),
    ).toEqual({ n: 0 });
    const log = [...blobs.map.entries()].filter(([k]) => k.startsWith("erase-log/"));
    expect(log).toHaveLength(1);
    const logText = log[0]?.[1] ?? "";
    for (const needle of [person.id, email, oldEmail]) expect(logText).not.toContain(needle);

    // The shared email stays for the bystander, without a body reference.
    const sharedRow = await env.DB.prepare(
      "SELECT body_ref, payload FROM core_activity WHERE external_key = ?",
    )
      .bind(`email:${shared.messageId}`)
      .first<{ body_ref: string | null; payload: string }>();
    expect(sharedRow?.body_ref).toBeNull();

    // The link row is gone; the ticket keeps the bystander as a watcher.
    expect(
      await env.DB.prepare(`SELECT 1 FROM x_${ext}_link WHERE id = ?`).bind(linkId).first(),
    ).toBeNull();
    const ticket = await env.DB.prepare(
      `SELECT contact, watchers, contact_email, summary FROM x_${ext}_ticket WHERE id = ?`,
    )
      .bind(ticketId)
      .first<Record<string, string | null>>();
    expect(ticket).toMatchObject({
      contact: null,
      watchers: JSON.stringify([bystander.id]),
      contact_email: null,
      summary: "Printer broken for [erased]",
    });
    // The kv entry keyed by them is gone; the other is redacted.
    expect(
      await env.DB.prepare("SELECT key FROM core_extension_kv WHERE extension_id = ?")
        .bind(ext)
        .all(),
    ).toMatchObject({ results: [{ key: "cache" }] });

    // Nothing anywhere: ids, emails (current and former), the phone in any form, the profile.
    const hits = await findAnywhere(
      [person.id, email, oldEmail, phone, digits, profile.toLowerCase()],
      auditKept,
    );
    expect(hits).toEqual([]);

    // Names, in the contexts known to be about them.
    const aboutThem = await env.DB.prepare(
      `SELECT (SELECT json_group_array(trigger || steps || coalesce(report, '') || coalesce(status_reason, '')) FROM core_automation_runs WHERE id = ?1) AS runs,
              (SELECT count(*) FROM core_notifications WHERE user_id = ?2) AS notes,
              (SELECT count(*) FROM x_${ext}_link) AS links,
              (SELECT coalesce(group_concat(nickname), '') FROM x_${ext}_person) AS nicks`,
    )
      .bind(aboutRun, member.id)
      .first<{ runs: string; notes: number; links: number; nicks: string }>();
    expect(aboutThem?.runs).not.toContain(given);
    expect(aboutThem?.runs).not.toContain(family);
    expect(aboutThem?.notes).toBe(0);
    expect(aboutThem?.nicks).not.toContain(family);
    const mention = await env.DB.prepare("SELECT steps FROM core_automation_runs WHERE id = ?")
      .bind(mentionRun)
      .first<{ steps: string }>();
    expect(mention?.steps).toContain("Unrelated line");

    // The address is on the erased-address list, as a hash only.
    const listed = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_erased_address WHERE hash IN (?, ?)",
    )
      .bind(await erasedAddressHash(email), await erasedAddressHash(oldEmail))
      .first<{ n: number }>();
    expect(listed?.n).toBe(2);

    // Erasing again is a no-op that still succeeds (retry safety): the record is gone.
    await expect(
      invoke("person.erase", { id: person.id }, context(admin, { blobs })),
    ).rejects.toThrow();
  });

  it("re-ingested mail drops an erased address: no links, payload entry, suggestion or body", async () => {
    const email = `${unique("gone")}@gone-${unique("d")}.example`;
    const person = await invoke(
      "person.create",
      { displayName: unique("Gone"), emails: [{ email }] },
      context(member),
    );
    await invoke("person.erase", { id: person.id }, context(admin));
    const keeper = await invoke(
      "person.create",
      { displayName: "Keeper", emails: [{ email: `${unique("k")}@keep.example` }] },
      context(member),
    );
    const keeperEmail = (
      await env.DB.prepare("SELECT email FROM core_person_emails WHERE person_id = ?")
        .bind(keeper.id)
        .first<{ email: string }>()
    )?.email as string;
    const conn = await connection(member);
    const fromThem = mail({ email, name: "Gone Person" }, [{ email: keeperEmail }], {
      signature: "Gone Person\nCEO",
    });
    const onlyThem = mail({ email }, [{ email: `me@${internal}` }]);
    const out = await ingest(member, conn, [fromThem, onlyThem]);
    expect(out.created).toBe(1);
    expect(out.bodies).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT body, body_ref, payload FROM core_activity WHERE external_key = ?",
    )
      .bind(`email:${fromThem.messageId}`)
      .first<{ body: string | null; body_ref: string | null; payload: string }>();
    expect(row?.body).toBeNull();
    expect(row?.body_ref).toBeNull();
    expect(row?.payload).not.toContain(email);
    expect(
      await env.DB.prepare("SELECT 1 FROM core_suggested_contact WHERE email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
    expect(await findAnywhere([email], auditKept)).toEqual([]);

    // An admin takes the address off the list when the person comes back by consent.
    await expect(invoke("erasure.allowAddress", { email }, context(member))).rejects.toThrow();
    expect(await invoke("erasure.addressStatus", { email }, context(admin))).toMatchObject({
      erased: true,
    });
    expect(await invoke("erasure.allowAddress", { email }, context(admin))).toEqual({
      removed: true,
    });
    await ingest(member, conn, [mail({ email }, [{ email: keeperEmail }])]);
    expect(
      await env.DB.prepare("SELECT 1 FROM core_suggested_contact WHERE email = ?")
        .bind(email)
        .first(),
    ).not.toBeNull();
  });
});

describe("organisation.erase reaches every store", () => {
  it("matches domains, website, street lines and former values, and clears relations", async () => {
    const name = unique("Zorblax");
    const domain = `${unique("zorb")}.example`;
    const oldDomain = `${unique("zold")}.example`;
    const street = `${unique("1 Zorb")} Street`;
    const org = await invoke(
      "organisation.create",
      {
        name,
        domains: [{ domain: oldDomain }],
        website: `https://${domain}/about`,
        addresses: [{ line1: street, city: "Springfield" }],
      },
      context(member),
    );
    await invoke("organisation.update", { id: org.id, domains: [{ domain }] }, context(member));
    const now = iso();
    const ticketId = newId("record");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO x_${ext}_organisation (id, motto) VALUES (?, ?)`).bind(
        org.id,
        `${name} rules`,
      ),
      env.DB.prepare(
        `INSERT INTO x_${ext}_ticket (id, created_at, updated_at, summary, company, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(ticketId, now, now, `Outage at ${name}`, org.id, `See ${oldDomain}`),
      env.DB.prepare(
        "INSERT INTO core_notifications (id, user_id, type, title, body, link, source, created_at) VALUES (?, ?, 'info', ?, NULL, ?, '{}', ?)",
      ).bind(newId("record"), member.id, `${name} renewed`, `/organisations/${org.id}`, now),
    ]);

    const result = await invoke("organisation.erase", { id: org.id }, context(admin));
    expect(result.notificationsDeleted).toBe(1);
    const ticket = await env.DB.prepare(
      `SELECT company, summary, notes FROM x_${ext}_ticket WHERE id = ?`,
    )
      .bind(ticketId)
      .first<Record<string, string | null>>();
    expect(ticket).toMatchObject({ company: null, summary: "Outage at [erased]" });
    expect(ticket?.notes).not.toContain(oldDomain);
    expect(await findAnywhere([org.id, domain, oldDomain, street], auditKept)).toEqual([]);
  });
});

describe("erase log", () => {
  it("re-applies an erasure after a restore brings the record back", async () => {
    const blobs = memoryBlobs();
    const email = `${unique("rs")}@restore.example`;
    const person = await invoke(
      "person.create",
      { displayName: unique("Restored"), emails: [{ email }] },
      context(member),
    );
    // Simulate a restore: capture the rows, erase, then put them back.
    const personRow = await env.DB.prepare("SELECT * FROM core_person WHERE id = ?")
      .bind(person.id)
      .first<Record<string, unknown>>();
    await invoke("person.erase", { id: person.id }, context(admin, { blobs }));
    const cols = Object.keys(personRow ?? {});
    await env.DB.prepare(
      `INSERT INTO core_person (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
      .bind(...cols.map((c) => personRow?.[c] ?? null))
      .run();
    await env.DB.prepare("DELETE FROM core_erased_address WHERE hash = ?")
      .bind(await erasedAddressHash(email))
      .run();

    const out = await invoke("erasure.reapply", {}, context(admin, { blobs }));
    expect(out.people).toEqual([person.id]);
    expect(
      await env.DB.prepare("SELECT 1 FROM core_person WHERE id = ?").bind(person.id).first(),
    ).toBeNull();
    expect(await invoke("erasure.addressStatus", { email }, context(admin))).toMatchObject({
      erased: true,
    });
    // Repeating it finds nothing more to do.
    expect((await invoke("erasure.reapply", {}, context(admin, { blobs }))).people).toEqual([]);
  });
});

describe("store helpers", () => {
  const terms = normaliseTerms(["ada@example.com", "+44 20 7946 0018", "per_x", "Personal"]);

  it("drops short terms and keeps the rest lower-cased", () => {
    expect(terms).toEqual(["ada@example.com", "+44 20 7946 0018", "personal"]);
  });

  it("redactJson drops identifying entries and erases mentioning strings whole", () => {
    const m = subjectMatcher(["ada@example.com", "+44 20 7946 0018"]);
    const pattern = aboutPattern(["ada@example.com"], ["Ada Lovelace"]);
    expect(
      redactJson(
        {
          to: [{ email: "ada@example.com", name: "Ada" }, { email: "bob@example.com" }],
          phone: "44 (20) 7946-0018",
          logs: ["Wrote to Ada Lovelace", "Other"],
        },
        m,
        pattern,
      ),
    ).toEqual({ to: [{ email: "bob@example.com" }], logs: ["[erased]", "Other"] });
  });

  it("withoutErased removes the address and the erased sender's words", () => {
    const item = {
      ...mail({ email: "gone@x.example" }, [{ email: "a@b.example" }, { email: "gone@x.example" }]),
      signature: "Gone",
      cc: [],
      threadKey: null,
      bounce: null,
    };
    const out = withoutErased(item, new Set(["gone@x.example"])) as typeof item;
    expect(out.from).toBeNull();
    expect(out.to).toEqual([{ email: "a@b.example" }]);
    expect(out).toMatchObject({ snippet: null, hasBody: false, signature: null });
  });
});
