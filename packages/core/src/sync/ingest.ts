// sync.ingest (ADR 0052, ADR 0112): one batch of normalised mail and calendar items from one
// connection, written onto CRM timelines in one D1 batch with one audit row.
//
// What it decides:
// - matching: people by email address, organisations by domain; internal domains never match;
// - dedupe across mailboxes: one activity per `external_key` ('email:<Message-ID>',
//   'ical:<UID>'), looked up through its unique index, never by scanning payloads;
// - threading: `thread_key` from References / In-Reply-To;
// - disclosure: the connection's sharing level (full: snippet in D1, body in R2; metadata:
//   subject, participants and time only; none: nothing);
// - deletes and updates: a key's activity goes to Trash when the last mailbox holding it drops it;
// - suggested contacts (counted once per distinct message) and job-change signals;
// - sync events for stage 5.
// Restricted reads never get here: the sync service drops them before building the batch.
import type { CoreDatabase } from "@relationship-os/db";
import { type Compilable, type Kysely, sql } from "kysely";
import { z } from "zod";
import { enqueueEmbeddings } from "../ai/embedding.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { eventInsert, type IntegrationEventInput } from "../integrations/events.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { erasedAddressHash } from "../records/erase-subject.ts";
import {
  domainOf,
  isAutomatedAddress,
  PUBLIC_EMAIL_DOMAINS,
  parseSignature,
  SNIPPET_MAX,
  signatureHash,
} from "./signals.ts";

// --- Settings ----------------------------------------------------------------------------------

export const SYNC_SETTINGS_KEY = "sync_settings";
export const SUGGESTION_THRESHOLD = 2;
export const DEFAULT_BACKFILL_DAYS = 90;

export const syncSettingsSchema = z.object({
  /** Domains whose addresses are colleagues: never matched, suggested or counted as external. */
  internalDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(50).default([]),
});
export type SyncSettings = z.infer<typeof syncSettingsSchema>;

/**
 * The internal domains: the setting, or when it is empty, the domains of the CRM's users'
 * addresses (except webmail providers).
 */
export async function internalDomains(db: Kysely<CoreDatabase>): Promise<Set<string>> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", SYNC_SETTINGS_KEY)
    .executeTakeFirst();
  let configured: string[] = [];
  if (row) {
    try {
      configured = syncSettingsSchema.parse(JSON.parse(row.value)).internalDomains;
    } catch {
      configured = [];
    }
  }
  if (configured.length) return new Set(configured);
  const users = await db
    .selectFrom("core_user")
    .select("email")
    .where("kind", "=", "human")
    .limit(500)
    .execute();
  return new Set(
    users
      .map((u) => domainOf(u.email.toLowerCase()))
      .filter((d) => d && !PUBLIC_EMAIL_DOMAINS.has(d)),
  );
}

// --- Input -------------------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().pipe(z.email().max(320));
const address = z.object({ email, name: z.string().trim().max(200).nullish() });
const isoDateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v).toISOString());
const providerId = z.string().min(1).max(500);

export const syncEmailItem = z.object({
  kind: z.literal("email"),
  op: z.literal("upsert"),
  providerId,
  /** RFC 5322 Message-ID, normalised (no angle brackets, lower case). */
  messageId: z.string().min(1).max(998),
  threadKey: z.string().max(1100).nullish(),
  subject: z.string().max(1000).nullish(),
  /** Plain text, at most SNIPPET_MAX characters. Stored only under full sharing. */
  snippet: z.string().max(SNIPPET_MAX).nullish(),
  /** The sync service holds the full body and will store it in R2 if this is written in full. */
  hasBody: z.boolean().default(false),
  from: address.nullish(),
  to: z.array(address).max(200).default([]),
  cc: z.array(address).max(200).default([]),
  sentAt: isoDateTime,
  /** A delivery-failure report and the addresses it says failed. */
  bounce: z.object({ failedRecipients: z.array(email).max(20) }).nullish(),
  /** The sender's signature block, for job-change signals. */
  signature: z.string().max(1200).nullish(),
});

export const syncMeetingItem = z.object({
  kind: z.literal("meeting"),
  op: z.literal("upsert"),
  providerId,
  /** iCalendar UID: the dedupe key across calendars. */
  uid: z.string().min(1).max(998),
  title: z.string().max(1000).nullish(),
  description: z.string().max(SNIPPET_MAX).nullish(),
  startsAt: isoDateTime,
  endsAt: isoDateTime.nullish(),
  location: z.string().max(500).nullish(),
  url: z.url().max(1000).nullish(),
  organizer: address.nullish(),
  attendees: z.array(address).max(200).default([]),
  cancelled: z.boolean().default(false),
});

export const syncDeleteItem = z.object({
  kind: z.enum(["email", "meeting"]),
  op: z.literal("delete"),
  providerId,
});

export const syncItemSchema = z.union([syncEmailItem, syncMeetingItem, syncDeleteItem]);
export type SyncItem = z.input<typeof syncItemSchema>;
type EmailItem = z.output<typeof syncEmailItem>;
type MeetingItem = z.output<typeof syncMeetingItem>;
type DeleteItem = z.output<typeof syncDeleteItem>;
type Item = EmailItem | MeetingItem | DeleteItem;

export const SYNC_BATCH_MAX = 50;

export function externalKeyOf(item: EmailItem | MeetingItem): string {
  return item.kind === "email" ? `email:${item.messageId}` : `ical:${item.uid}`;
}

/** The R2 key of a synced email's full body. */
export function bodyKeyFor(externalKey: string): string {
  return `email-bodies/${encodeURIComponent(externalKey)}`;
}

// --- Handler -----------------------------------------------------------------------------------

interface ExistingActivity {
  id: string;
  external_key: string | null;
  deleted_at: string | null;
  disclosure: "full" | "metadata" | null;
  body_ref: string | null;
  subject: string | null;
  occurred_at: string;
  payload: string;
}

interface Ingest {
  ctx: HandlerContext;
  connectionId: string;
  ownerId: string;
  sharing: "full" | "metadata";
  internal: Set<string>;
  people: Map<string, string>;
  orgs: Map<string, string>;
  activities: Map<string, ExistingActivity>;
  mappings: Map<string, { external_key: string; activity_id: string | null }>;
  /** external_key → connections (other than this one) still holding it. */
  holders: Map<string, Set<string>>;
  /** Keys this batch already counted for suggestions. */
  counted: Set<string>;
  statements: Compilable[];
  events: IntegrationEventInput[];
  out: {
    created: number;
    updated: number;
    skipped: number;
    deleted: number;
    bodies: { externalKey: string; activityId: string; key: string }[];
    removedBodies: string[];
  };
}

function isExternal(ing: Ingest, emailAddress: string): boolean {
  return !ing.internal.has(domainOf(emailAddress));
}

function emailsOf(item: Item): string[] {
  if (item.op === "delete") return [];
  if (item.kind === "email") {
    return [
      item.from?.email,
      ...item.to.map((a) => a.email),
      ...item.cc.map((a) => a.email),
    ].filter((e): e is string => Boolean(e));
  }
  return [item.organizer?.email, ...item.attendees.map((a) => a.email)].filter((e): e is string =>
    Boolean(e),
  );
}

function linksFor(ing: Ingest, addresses: readonly string[]) {
  const people = new Set<string>();
  const orgs = new Set<string>();
  for (const a of addresses) {
    if (!isExternal(ing, a)) continue;
    const person = ing.people.get(a);
    if (person) people.add(person);
    const domain = domainOf(a);
    const org = PUBLIC_EMAIL_DOMAINS.has(domain) ? undefined : ing.orgs.get(domain);
    if (org) orgs.add(org);
  }
  return { people: [...people], orgs: [...orgs] };
}

function linkRows(activityId: string, links: { people: string[]; orgs: string[] }) {
  return [
    ...links.people.map((id) => ({
      activity_id: activityId,
      object_type: "person",
      record_id: id,
    })),
    ...links.orgs.map((id) => ({
      activity_id: activityId,
      object_type: "organisation",
      record_id: id,
    })),
  ];
}

function queueLinks(ing: Ingest, activityId: string, links: { people: string[]; orgs: string[] }) {
  const rows = linkRows(activityId, links);
  for (let i = 0; i < rows.length; i += 30) {
    ing.statements.push(
      ing.ctx.db
        .insertInto("core_activity_links")
        .values(rows.slice(i, i + 30))
        .onConflict((oc) => oc.doNothing()),
    );
  }
}

function queueMapping(ing: Ingest, item: Item, key: string, activityId: string | null) {
  const occurredAt =
    item.op === "upsert" ? (item.kind === "email" ? item.sentAt : item.startsAt) : null;
  ing.statements.push(
    ing.ctx.db
      .insertInto("core_sync_item")
      .values({
        connection_id: ing.connectionId,
        provider_id: item.providerId,
        external_key: key,
        kind: item.kind,
        activity_id: activityId,
        occurred_at: occurredAt,
        updated_at: ing.ctx.now,
      })
      .onConflict((oc) =>
        oc.columns(["connection_id", "provider_id"]).doUpdateSet({
          external_key: key,
          activity_id: activityId,
          occurred_at: occurredAt,
          updated_at: ing.ctx.now,
        }),
      ),
  );
  ing.mappings.set(item.providerId, { external_key: key, activity_id: activityId });
}

/** Counts each external, unknown address once per distinct message (cost audit U2). */
function countSuggestions(ing: Ingest, key: string, item: EmailItem) {
  if (ing.counted.has(key) || ing.holders.has(key)) return;
  ing.counted.add(key);
  if (item.bounce) return;
  const named = new Map<string, string | null>();
  for (const a of [item.from, ...item.to, ...item.cc]) {
    if (a) named.set(a.email, a.name ?? named.get(a.email) ?? null);
  }
  for (const [address, name] of named) {
    if (!isExternal(ing, address) || ing.people.has(address) || isAutomatedAddress(address)) {
      continue;
    }
    ing.statements.push(
      ing.ctx.db
        .insertInto("core_suggested_contact")
        .values({
          email: address,
          domain: domainOf(address),
          name: name ?? null,
          message_count: 1,
          first_seen_at: item.sentAt,
          last_seen_at: item.sentAt,
          status: "open",
        })
        .onConflict((oc) =>
          oc.column("email").doUpdateSet((eb) => ({
            message_count: eb("core_suggested_contact.message_count", "+", 1),
            name: sql<string | null>`coalesce(core_suggested_contact.name, excluded.name)`,
            last_seen_at: sql<string>`max(core_suggested_contact.last_seen_at, excluded.last_seen_at)`,
          })),
        ),
    );
  }
}

function suggestJobChange(
  ing: Ingest,
  personId: string,
  signal: "bounce" | "signature" | "domain",
  dedupeKey: string,
  evidence: Record<string, unknown>,
  proposal: Record<string, unknown>,
) {
  ing.statements.push(
    ing.ctx.db
      .insertInto("core_job_change_suggestion")
      .values({
        id: newId("jobChange"),
        person_id: personId,
        signal,
        dedupe_key: dedupeKey,
        evidence: JSON.stringify(evidence),
        proposal: JSON.stringify(proposal),
        status: "open",
        created_at: ing.ctx.now,
      })
      .onConflict((oc) => oc.doNothing()),
  );
}

async function signals(ing: Ingest, items: EmailItem[]) {
  const { db } = ing.ctx;
  // Bounces from a known person's address.
  for (const item of items) {
    for (const failed of item.bounce?.failedRecipients ?? []) {
      const person = ing.people.get(failed);
      if (!person) continue;
      suggestJobChange(
        ing,
        person,
        "bounce",
        `bounce:${failed}`,
        { email: failed, messageId: item.messageId, at: item.sentAt, subject: item.subject },
        { endOnly: true, reason: `Mail to ${failed} bounced` },
      );
    }
  }
  // New signatures from known people.
  const signed = items.filter(
    (i) => i.signature && i.from && isExternal(ing, i.from.email) && ing.people.has(i.from.email),
  );
  if (signed.length) {
    const ids = [...new Set(signed.map((i) => ing.people.get(i.from?.email ?? "") ?? ""))];
    const [known, current] = await Promise.all([
      db
        .selectFrom("core_person_signature")
        .selectAll()
        .where("person_id", "in", jsonList(ids))
        .execute(),
      db
        .selectFrom("core_affiliation as a")
        .innerJoin("core_organisation as o", "o.id", "a.organisation_id")
        .innerJoin("core_person as p", "p.id", "a.person_id")
        .select(["a.person_id", "a.title", "o.name as org_name", "p.display_name"])
        .where("a.person_id", "in", jsonList(ids))
        .where("a.is_primary", "=", 1)
        .where("a.deleted_at", "is", null)
        .execute(),
    ]);
    const seen = new Map(known.map((k) => [k.person_id, k]));
    const jobs = new Map(current.map((c) => [c.person_id, c]));
    for (const item of signed) {
      const sender = item.from?.email ?? "";
      const person = ing.people.get(sender) ?? "";
      const text = item.signature ?? "";
      const hash = signatureHash(text);
      const before = seen.get(person);
      const job = jobs.get(person);
      const parsed = parseSignature(text, job?.display_name ?? item.from?.name);
      if (before && before.signature_hash !== hash) {
        const company = parsed.company;
        const orgChanged =
          company && job?.org_name && company.toLowerCase() !== job.org_name.toLowerCase();
        if (orgChanged) {
          suggestJobChange(
            ing,
            person,
            "signature",
            `signature:${hash}`,
            {
              email: sender,
              signature: text,
              previousCompany: before.company,
              messageId: item.messageId,
              at: item.sentAt,
            },
            { organisationName: company, title: parsed.title },
          );
        }
      }
      seen.set(person, {
        person_id: person,
        email: sender,
        signature_hash: hash,
        company: parsed.company,
        title: parsed.title,
        seen_at: item.sentAt,
      });
      ing.statements.push(
        db
          .insertInto("core_person_signature")
          .values({
            person_id: person,
            email: sender,
            signature_hash: hash,
            company: parsed.company,
            title: parsed.title,
            seen_at: item.sentAt,
          })
          .onConflict((oc) =>
            oc.column("person_id").doUpdateSet({
              email: sender,
              signature_hash: hash,
              company: parsed.company,
              title: parsed.title,
              seen_at: item.sentAt,
            }),
          ),
      );
    }
  }
  // A known person (same name) writing from an unknown address at a new domain.
  const strangers = items.filter(
    (i) =>
      i.from?.name &&
      isExternal(ing, i.from.email) &&
      !ing.people.has(i.from.email) &&
      !isAutomatedAddress(i.from.email) &&
      !PUBLIC_EMAIL_DOMAINS.has(domainOf(i.from.email)),
  );
  if (strangers.length) {
    const names = [...new Set(strangers.map((i) => (i.from?.name ?? "").toLowerCase()))].slice(
      0,
      50,
    );
    const matches = await db
      .selectFrom("core_person as p")
      .innerJoin("core_person_emails as e", "e.person_id", "p.id")
      .select(["p.id", "p.display_name", "e.email"])
      .where(
        sql<boolean>`lower(p.display_name) IN (SELECT value FROM json_each(${JSON.stringify(names)}))`,
      )
      .where("p.deleted_at", "is", null)
      .limit(200)
      .execute();
    for (const item of strangers) {
      const sender = item.from?.email ?? "";
      const domain = domainOf(sender);
      const candidates = matches.filter(
        (m) => m.display_name.toLowerCase() === (item.from?.name ?? "").toLowerCase(),
      );
      const ids = [...new Set(candidates.map((c) => c.id))];
      // Exactly one person by that name, none of whose addresses is at the new domain.
      if (ids.length !== 1) continue;
      const [person] = ids;
      if (!person || candidates.some((c) => domainOf(c.email) === domain)) continue;
      suggestJobChange(
        ing,
        person,
        "domain",
        `domain:${domain}`,
        {
          email: sender,
          previousEmails: candidates.map((c) => c.email),
          messageId: item.messageId,
          at: item.sentAt,
        },
        { domain, organisationId: ing.orgs.get(domain) ?? null, newEmail: sender },
      );
    }
  }
}

function emailPayload(item: EmailItem, direction: "inbound" | "outbound", threadKey: string) {
  const strip = (a: { email: string; name?: string | null | undefined }) =>
    a.name ? { email: a.email, name: a.name } : { email: a.email };
  return {
    direction,
    ...(item.from ? { from: strip(item.from) } : {}),
    to: item.to.map(strip),
    cc: item.cc.map(strip),
    messageId: item.messageId,
    threadId: threadKey,
  };
}

function meetingPayload(ing: Ingest, item: MeetingItem) {
  return {
    startsAt: item.startsAt,
    ...(item.endsAt ? { endsAt: item.endsAt } : {}),
    ...(item.location ? { location: item.location } : {}),
    ...(item.url ? { url: item.url } : {}),
    attendees: item.attendees.map((a) => {
      const personId = ing.people.get(a.email);
      return {
        email: a.email,
        ...(a.name ? { name: a.name } : {}),
        ...(personId ? { personId } : {}),
      };
    }),
  };
}

function upsertEmail(ing: Ingest, item: EmailItem) {
  const { db, now } = ing.ctx;
  const key = externalKeyOf(item);
  const threadKey = item.threadKey ?? `thread:${item.messageId}`;
  const addresses = emailsOf(item);
  const links = linksFor(ing, addresses);
  const direction =
    item.from && !isExternal(ing, item.from.email) ? ("outbound" as const) : ("inbound" as const);
  const existing = ing.activities.get(key);
  countSuggestions(ing, key, item);

  if (existing) {
    queueMapping(ing, item, key, existing.id);
    if (existing.deleted_at) return void ing.out.skipped++;
    queueLinks(ing, existing.id, links);
    // A mailbox sharing full content upgrades an activity another mailbox shared as metadata.
    if (ing.sharing === "full" && existing.disclosure === "metadata") {
      const bodyKey = item.hasBody ? bodyKeyFor(key) : null;
      ing.statements.push(
        db
          .updateTable("core_activity")
          .set({
            body: item.snippet ?? null,
            disclosure: "full",
            body_ref: bodyKey,
            updated_at: now,
          })
          .where("id", "=", existing.id),
      );
      if (bodyKey) ing.out.bodies.push({ externalKey: key, activityId: existing.id, key: bodyKey });
      existing.disclosure = "full";
    }
    return void ing.out.updated++;
  }
  if (!links.people.length && !links.orgs.length) {
    queueMapping(ing, item, key, null);
    return void ing.out.skipped++;
  }
  const id = newId("activity");
  const bodyKey = ing.sharing === "full" && item.hasBody ? bodyKeyFor(key) : null;
  ing.statements.push(
    db.insertInto("core_activity").values({
      id,
      type: "email",
      subject: item.subject?.trim() || "(no subject)",
      body: ing.sharing === "full" ? (item.snippet ?? null) : null,
      payload: JSON.stringify(emailPayload(item, direction, threadKey)),
      occurred_at: item.sentAt,
      author_user_id: ing.ownerId,
      author_actor: "automation",
      created_at: now,
      updated_at: now,
      external_key: key,
      thread_key: threadKey,
      body_ref: bodyKey,
      disclosure: ing.sharing,
    }),
  );
  queueLinks(ing, id, links);
  queueMapping(ing, item, key, id);
  ing.activities.set(key, {
    id,
    external_key: key,
    deleted_at: null,
    disclosure: ing.sharing,
    body_ref: bodyKey,
    subject: item.subject ?? null,
    occurred_at: item.sentAt,
    payload: "{}",
  });
  if (bodyKey) ing.out.bodies.push({ externalKey: key, activityId: id, key: bodyKey });
  ing.events.push({
    source: "sync",
    connectionId: ing.connectionId,
    type: direction === "inbound" ? "email.received" : "email.sent",
    payload: {
      activityId: id,
      direction,
      personIds: links.people,
      organisationIds: links.orgs,
    },
    occurredAt: item.sentAt,
  });
  ing.out.created++;
}

function upsertMeeting(ing: Ingest, item: MeetingItem) {
  const { db, now } = ing.ctx;
  const key = externalKeyOf(item);
  const links = linksFor(ing, emailsOf(item));
  const existing = ing.activities.get(key);
  const subject = item.title?.trim() || "(untitled meeting)";
  const body = ing.sharing === "full" ? (item.description ?? null) : null;
  const payload = JSON.stringify(meetingPayload(ing, item));
  const event = (type: string, activityId: string) =>
    ing.events.push({
      source: "sync",
      connectionId: ing.connectionId,
      type,
      payload: { activityId, personIds: links.people, organisationIds: links.orgs },
      occurredAt: item.startsAt,
    });

  if (existing) {
    queueMapping(ing, item, key, existing.id);
    if (existing.deleted_at) return void ing.out.skipped++;
    if (item.cancelled) {
      ing.statements.push(
        db
          .updateTable("core_activity")
          .set({ deleted_at: now, deleted_by: ing.ownerId, updated_at: now })
          .where("id", "=", existing.id)
          .where("deleted_at", "is", null),
      );
      existing.deleted_at = now;
      event("meeting.cancelled", existing.id);
      return void ing.out.deleted++;
    }
    queueLinks(ing, existing.id, links);
    const changed =
      existing.subject !== subject ||
      existing.occurred_at !== item.startsAt ||
      existing.payload !== payload;
    if (changed) {
      ing.statements.push(
        db
          .updateTable("core_activity")
          .set({
            subject,
            occurred_at: item.startsAt,
            payload,
            ...(ing.sharing === "full" || existing.disclosure === "metadata" ? { body } : {}),
            updated_at: now,
          })
          .where("id", "=", existing.id),
      );
      Object.assign(existing, { subject, occurred_at: item.startsAt, payload });
      event("meeting.updated", existing.id);
    }
    return void ing.out.updated++;
  }
  if (item.cancelled || (!links.people.length && !links.orgs.length)) {
    queueMapping(ing, item, key, null);
    return void ing.out.skipped++;
  }
  const id = newId("activity");
  ing.statements.push(
    db.insertInto("core_activity").values({
      id,
      type: "meeting",
      subject,
      body,
      payload,
      occurred_at: item.startsAt,
      author_user_id: ing.ownerId,
      author_actor: "automation",
      created_at: now,
      updated_at: now,
      external_key: key,
      disclosure: ing.sharing,
    }),
  );
  queueLinks(ing, id, links);
  queueMapping(ing, item, key, id);
  ing.activities.set(key, {
    id,
    external_key: key,
    deleted_at: null,
    disclosure: ing.sharing,
    body_ref: null,
    subject,
    occurred_at: item.startsAt,
    payload,
  });
  event("meeting.created", id);
  ing.out.created++;
}

function deleteItem(ing: Ingest, item: DeleteItem) {
  const { db, now } = ing.ctx;
  const mapping = ing.mappings.get(item.providerId);
  if (!mapping) return void ing.out.skipped++;
  ing.statements.push(
    db
      .deleteFrom("core_sync_item")
      .where("connection_id", "=", ing.connectionId)
      .where("provider_id", "=", item.providerId),
  );
  ing.mappings.delete(item.providerId);
  const stillHeld =
    (ing.holders.get(mapping.external_key)?.size ?? 0) > 0 ||
    [...ing.mappings.values()].some((m) => m.external_key === mapping.external_key);
  const activity = ing.activities.get(mapping.external_key);
  if (stillHeld || !activity || activity.deleted_at) return void ing.out.skipped++;
  ing.statements.push(
    db
      .updateTable("core_activity")
      .set({ deleted_at: now, deleted_by: ing.ownerId, body_ref: null, updated_at: now })
      .where("id", "=", activity.id)
      .where("deleted_at", "is", null),
  );
  if (activity.body_ref) ing.out.removedBodies.push(activity.body_ref);
  activity.deleted_at = now;
  ing.events.push({
    source: "sync",
    connectionId: ing.connectionId,
    type: item.kind === "email" ? "email.deleted" : "meeting.cancelled",
    payload: { activityId: activity.id },
    occurredAt: now,
  });
  ing.out.deleted++;
}

/**
 * The addresses in `addresses` that belong to erased people (ADR 0320): looked up by hash in
 * core_erased_address (primary key), so the list never holds an address.
 */
export async function erasedAddresses(
  db: Kysely<CoreDatabase>,
  addresses: readonly string[],
): Promise<Set<string>> {
  if (!addresses.length) return new Set();
  const hashes = await Promise.all(
    addresses.map(async (a) => ({ address: a, hash: await erasedAddressHash(a) })),
  );
  const rows = await db
    .selectFrom("core_erased_address")
    .select("hash")
    .where("hash", "in", jsonList(hashes.map((h) => h.hash)))
    .execute();
  const found = new Set(rows.map((r) => r.hash));
  return new Set(hashes.filter((h) => found.has(h.hash)).map((h) => h.address));
}

/**
 * An item with erased addresses removed: from participants, attendees and bounce reports. A
 * message from an erased sender also loses its snippet, body and signature (their own words), and
 * a meeting they organised its description.
 */
export function withoutErased(item: Item, erased: ReadonlySet<string>): Item {
  if (item.op === "delete") return item;
  const keep = (a: { email: string }) => !erased.has(a.email);
  if (item.kind === "email") {
    const fromErased = item.from ? erased.has(item.from.email) : false;
    return {
      ...item,
      from: fromErased ? null : item.from,
      to: item.to.filter(keep),
      cc: item.cc.filter(keep),
      ...(fromErased ? { snippet: null, hasBody: false, signature: null } : {}),
      ...(item.bounce
        ? {
            bounce: {
              failedRecipients: item.bounce.failedRecipients.filter((e) => !erased.has(e)),
            },
          }
        : {}),
    };
  }
  const organiserErased = item.organizer ? erased.has(item.organizer.email) : false;
  return {
    ...item,
    organizer: organiserErased ? null : item.organizer,
    attendees: item.attendees.filter(keep),
    ...(organiserErased ? { description: null } : {}),
  };
}

const ingestOutput = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  deleted: z.number(),
  /** Full bodies the caller must now put in R2 (keys written on the activities). */
  bodies: z.array(z.object({ externalKey: z.string(), activityId: z.string(), key: z.string() })),
  /** R2 keys the caller must delete (bodies of activities this batch sent to Trash). */
  removedBodies: z.array(z.string()),
});

export const syncIngest = defineOperation({
  name: "sync.ingest",
  description:
    "Internal to the sync service: writes one batch of normalised mail and calendar items " +
    "from one connection onto CRM timelines (matching, dedupe across mailboxes, threading, " +
    "deletes and updates, suggestions and sync events) in one transaction with one audit row.",
  input: z.object({
    connectionId: z.string().startsWith("con_").max(64),
    items: z.array(syncItemSchema).min(1).max(SYNC_BATCH_MAX),
  }),
  output: ingestOutput,
  permission: "records:write",
  risk: "write",
  actors: ["automation"],
  mcp: { expose: false },
  // Audits keep who and which messages, not content (cost audit U1).
  redact: ["snippet", "description", "signature"],
  auditSummary: (output) => ({
    created: output.created,
    updated: output.updated,
    skipped: output.skipped,
    deleted: output.deleted,
  }),
  async handler(input, ctx) {
    const conn = await ctx.db
      .selectFrom("core_integration_connection")
      .select(["id", "owner_user_id", "sharing_level", "status"])
      .where("id", "=", input.connectionId)
      .executeTakeFirst();
    if (!conn) throw new NotFoundError("connection", input.connectionId);
    if (conn.owner_user_id !== ctx.user.id) {
      throw new ValidationError("Sync runs as the connection's owner");
    }
    const out: Ingest["out"] = {
      created: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      bodies: [],
      removedBodies: [],
    };
    // "Don't sync" writes nothing at all, not even suggestions.
    if (conn.sharing_level === "none" || conn.status === "disconnected") {
      return { ...out, skipped: input.items.length };
    }
    const sharing = conn.sharing_level === "full" ? "full" : "metadata";
    const addressesOf = (list: readonly Item[]) => [
      ...new Set([
        ...list.flatMap(emailsOf),
        // Bounced addresses are looked up too, for job-change signals.
        ...list.flatMap((i) =>
          i.op === "upsert" && i.kind === "email" ? (i.bounce?.failedRecipients ?? []) : [],
        ),
      ]),
    ];
    // Erased people's addresses (ADR 0320) are dropped before anything else sees the batch.
    const [internal, erased] = await Promise.all([
      internalDomains(ctx.db),
      erasedAddresses(ctx.db, addressesOf(input.items as Item[])),
    ]);
    const items = input.items as Item[];
    // Replaced in place: the pipeline writes this call's audit row from `input` after the
    // handler returns, so the audit log never records an erased address either.
    if (erased.size) items.forEach((item, i) => (items[i] = withoutErased(item, erased)));
    const addresses = addressesOf(items);
    const domains = [
      ...new Set(
        addresses
          .filter((a) => !internal.has(domainOf(a)))
          .map(domainOf)
          .filter((d) => !PUBLIC_EMAIL_DOMAINS.has(d)),
      ),
    ];
    const upserts = items.filter((i): i is EmailItem | MeetingItem => i.op === "upsert");
    const providerIds = items.map((i) => i.providerId);
    const [people, orgs, mappings] = await Promise.all([
      addresses.length
        ? ctx.db
            .selectFrom("core_person_emails")
            .select(["email", "person_id"])
            .where("email", "in", jsonList(addresses))
            .where("live", "=", 1)
            .execute()
        : [],
      domains.length
        ? ctx.db
            .selectFrom("core_organisation_domains")
            .select(["domain", "organisation_id"])
            .where("domain", "in", jsonList(domains))
            .where("live", "=", 1)
            .execute()
        : [],
      ctx.db
        .selectFrom("core_sync_item")
        .select(["provider_id", "external_key", "activity_id"])
        .where("connection_id", "=", conn.id)
        .where("provider_id", "in", jsonList(providerIds))
        .execute(),
    ]);
    const mappingMap = new Map(mappings.map((m) => [m.provider_id, m]));
    const keys = [
      ...new Set([...upserts.map(externalKeyOf), ...mappings.map((m) => m.external_key)]),
    ];
    const [activities, holders] = await Promise.all([
      keys.length
        ? ctx.db
            .selectFrom("core_activity")
            .select([
              "id",
              "external_key",
              "deleted_at",
              "disclosure",
              "body_ref",
              "subject",
              "occurred_at",
              "payload",
            ])
            .where("external_key", "in", jsonList(keys))
            .execute()
        : [],
      keys.length
        ? ctx.db
            .selectFrom("core_sync_item")
            .select(["external_key", "connection_id"])
            .where("external_key", "in", jsonList(keys))
            .where("connection_id", "<>", conn.id)
            .execute()
        : [],
    ]);
    const holderMap = new Map<string, Set<string>>();
    for (const h of holders) {
      const set = holderMap.get(h.external_key) ?? new Set<string>();
      set.add(h.connection_id);
      holderMap.set(h.external_key, set);
    }
    const ing: Ingest = {
      ctx,
      connectionId: conn.id,
      ownerId: conn.owner_user_id,
      sharing,
      internal,
      people: new Map(people.map((p) => [p.email, p.person_id])),
      orgs: new Map(orgs.map((o) => [o.domain, o.organisation_id])),
      activities: new Map(
        activities.map((a) => [a.external_key ?? "", a as ExistingActivity] as const),
      ),
      mappings: mappingMap,
      holders: holderMap,
      counted: new Set(),
      statements: [],
      events: [],
      out,
    };
    // A message this mailbox already synced is counted again only if it is new to the CRM.
    for (const m of mappings) ing.counted.add(m.external_key);
    for (const item of items) {
      if (item.op === "delete") deleteItem(ing, item);
      else if (item.kind === "email") upsertEmail(ing, item);
      else upsertMeeting(ing, item);
    }
    await signals(
      ing,
      upserts.filter((i): i is EmailItem => i.kind === "email"),
    );
    ctx.write(
      ...ing.statements,
      ...ing.events.map((e) => eventInsert(ctx.pipeline.crm, e, ctx.now)),
    );
    // Synced activities queue for embedding like any other change (ADR 0154); the drain applies
    // the disclosure rules (metadata-only and private activities are never embedded).
    const touched = ing.events
      .map((e) => (e.payload as { activityId?: unknown }).activityId)
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ object: "activity", id }));
    const enqueue = enqueueEmbeddings(ctx.db, touched, ctx.now);
    if (enqueue) ctx.write(enqueue);
    ctx.write(
      ctx.db
        .updateTable("core_integration_connection")
        .set({ last_sync_at: ctx.now })
        .where("id", "=", conn.id),
    );
    return out;
  },
});

/**
 * The provider ids this connection synced into live activities within [from, to), for delete
 * reconciliation (ADR 0112): what the provider no longer lists in that window was deleted. Walks
 * core_sync_item_window_idx, so it reads only the window's rows.
 */
export async function syncedInWindow(
  db: Kysely<CoreDatabase>,
  input: {
    connectionId: string;
    kind: "email" | "meeting";
    from: string;
    to: string;
    limit?: number;
  },
): Promise<string[]> {
  const rows = await db
    .selectFrom("core_sync_item")
    .select("provider_id")
    .where("connection_id", "=", input.connectionId)
    .where("kind", "=", input.kind)
    .where("occurred_at", ">=", input.from)
    .where("occurred_at", "<", input.to)
    .where("activity_id", "is not", null)
    .limit(input.limit ?? 2000)
    .execute();
  return rows.map((r) => r.provider_id);
}

// --- Settings operations -----------------------------------------------------------------------

export const syncGetSettings = defineOperation({
  name: "sync.getSettings",
  description:
    "The org's mail and calendar sync settings: internal domains (colleagues' addresses, " +
    "never matched to people or suggested; when empty, the domains of the CRM users' own " +
    "addresses are used). Read-only.",
  input: z.object({}),
  output: z.object({
    internalDomains: z.array(z.string()),
    effectiveInternalDomains: z.array(z.string()),
    backfillDays: z.number(),
    suggestionThreshold: z.number(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const row = await ctx.db
      .selectFrom("core_settings")
      .select("value")
      .where("key", "=", SYNC_SETTINGS_KEY)
      .executeTakeFirst();
    let configured: string[] = [];
    try {
      configured = row ? syncSettingsSchema.parse(JSON.parse(row.value)).internalDomains : [];
    } catch {
      configured = [];
    }
    return {
      internalDomains: configured,
      effectiveInternalDomains: [...(await internalDomains(ctx.db))].sort(),
      backfillDays: DEFAULT_BACKFILL_DAYS,
      suggestionThreshold: SUGGESTION_THRESHOLD,
    };
  },
});

export const syncSetSettings = defineOperation({
  name: "sync.setSettings",
  description:
    "Set the org's internal domains for mail and calendar sync. Admins only; people only.",
  input: syncSettingsSchema,
  output: z.object({ internalDomains: z.array(z.string()) }),
  permission: "integrations:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const value = JSON.stringify({ internalDomains: [...new Set(input.internalDomains)] });
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: SYNC_SETTINGS_KEY, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: SYNC_SETTINGS_KEY,
      action: "update",
      after: { internalDomains: input.internalDomains },
    });
    return { internalDomains: [...new Set(input.internalDomains)] };
  },
});

export const syncOperations = [syncIngest, syncGetSettings, syncSetSettings] as const;
