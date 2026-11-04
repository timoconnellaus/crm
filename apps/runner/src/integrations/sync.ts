// Sync adapters (ADR 0052, ADR 0112): read one mailbox or calendar through its gatekeeper session
// and normalise what it holds into sync.ingest items. One pass reads one chunk (a page of
// changes, or one time window), so the integration host can run backfill and catch-up as a chain
// of short alarms. Every content read goes through the session's ApprovalQueue; a read the
// gatekeeper flags containsRestrictedData is dropped here and never reaches sync.ingest, D1, the
// search index or R2.
import {
  extractSignature,
  failedRecipients,
  htmlToText,
  isBounce,
  normaliseEmail,
  normaliseMessageId,
  parseMessageIds,
  type SyncItem,
  snippetOf,
  threadKeyFor,
} from "@crm/core";
import type { ObservationTracker } from "./queue.ts";

export type SyncKind = "mail" | "calendar";

export interface PullResult {
  items: SyncItem[];
  /** Full bodies by external key ('email:<Message-ID>'), stored in R2 under full sharing. */
  bodies: Map<string, string>;
  /** Where the next pass starts. */
  cursor: string | null;
  /** True when the adapter has more to read right away (backfill continues). */
  more: boolean;
  /** Reads dropped because the gatekeeper flagged them restricted. */
  restricted: number;
}

export interface PullContext {
  /** Nothing older than this is read (the backfill window, default 90 days). */
  since: string;
  now: string;
  tracker: ObservationTracker;
  limit: number;
}

export interface SyncAdapter {
  kind: SyncKind;
  pull(session: unknown, cursor: string | null, ctx: PullContext): Promise<PullResult>;
  /** Subscribes the session's push hook (new mail) so a change triggers a pass. */
  subscribe?(session: unknown, hook: unknown): Promise<void>;
  /**
   * Every provider id in [from, to), without reading content, for delete reconciliation
   * (ADR 0112): what the CRM synced in that window and the provider no longer lists was deleted.
   * `complete` is false when the listing was cut short (then nothing is deleted).
   */
  listIds?(session: unknown, from: Date, to: Date): Promise<{ ids: string[]; complete: boolean }>;
}

/** Reconciliation reads at most this many ids per window. */
export const RECONCILE_MAX = 2000;

async function drainAll<T>(
  cursor: { next(): Promise<T[] | null> },
  max: number,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  for (;;) {
    const page = await cursor.next();
    if (!page?.length) return { items, complete: true };
    items.push(...page);
    if (items.length > max) return { items: items.slice(0, max), complete: false };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: gatekeeper sessions are RPC stubs typed by each vendor's .d.ts, which crm-runner does not import.
type Session = any;

interface RawMail {
  providerId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { email: string; name?: string } | null;
  to: { email: string; name?: string }[];
  cc: { email: string; name?: string }[];
  subject: string;
  text: string;
  sentAt: string;
  headers: Record<string, string | undefined>;
}

function addresses(list: unknown): { email: string; name?: string }[] {
  if (!Array.isArray(list)) return [];
  const out: { email: string; name?: string }[] = [];
  for (const entry of list) {
    const e = entry as { email?: string; address?: string; name?: string };
    const email = normaliseEmail(e.email ?? e.address);
    if (email) out.push(e.name ? { email, name: String(e.name).slice(0, 200) } : { email });
  }
  return out.slice(0, 200);
}

/** One raw message as a sync.ingest item (and its full body). */
export function normaliseMail(raw: RawMail): { item: SyncItem; body: string } | null {
  const messageId = raw.messageId ?? `provider.${raw.providerId}`;
  const from = raw.from ? (addresses([raw.from])[0] ?? null) : null;
  const bounce = isBounce(from?.email ?? null, raw.subject)
    ? { failedRecipients: failedRecipients(raw.headers, raw.text) }
    : null;
  const item: SyncItem = {
    kind: "email",
    op: "upsert",
    providerId: raw.providerId,
    messageId,
    threadKey: threadKeyFor(messageId, raw.references, raw.inReplyTo),
    subject: raw.subject.slice(0, 1000),
    snippet: snippetOf(raw.text),
    hasBody: raw.text.trim().length > 0,
    from,
    to: addresses(raw.to),
    cc: addresses(raw.cc),
    sentAt: raw.sentAt,
    ...(bounce?.failedRecipients.length ? { bounce } : {}),
    signature: extractSignature(raw.text)?.slice(0, 1200) ?? null,
  };
  return { item, body: raw.text };
}

// --- The fake provider (tests and development) -------------------------------------------------

export const fakeMailAdapter: SyncAdapter = {
  kind: "mail",
  // The fake has a change feed, and also lists by window so delete reconciliation is tested.
  async listIds(session: Session, from, to) {
    const ids = (await session.listIdsBetween(from.toISOString(), to.toISOString())) as string[];
    return { ids, complete: true };
  },
  async pull(session: Session, cursor, ctx) {
    const page = (await session.listChanges(cursor, ctx.limit)) as {
      items: { id: string; op: "upsert" | "delete" }[];
      next: string | null;
    };
    const result: PullResult = {
      items: [],
      bodies: new Map(),
      cursor: page.next,
      more: page.items.length >= ctx.limit,
      restricted: 0,
    };
    for (const change of page.items) {
      if (change.op === "delete") {
        result.items.push({ kind: "email", op: "delete", providerId: change.id });
        continue;
      }
      ctx.tracker.reset();
      let message: {
        id: string;
        messageId: string;
        inReplyTo?: string;
        references?: string[];
        from: { email: string; name?: string };
        to: { email: string; name?: string }[];
        cc?: { email: string; name?: string }[];
        subject: string;
        text: string;
        sentAt: string;
        headers?: Record<string, string>;
      };
      try {
        message = await session.getMessage(change.id);
      } catch {
        continue; // gone meanwhile
      }
      if (ctx.tracker.restricted) {
        result.restricted += 1;
        continue;
      }
      if (message.sentAt < ctx.since) continue;
      const normalised = normaliseMail({
        providerId: message.id,
        messageId: normaliseMessageId(message.messageId),
        inReplyTo: message.inReplyTo ?? null,
        references: (message.references ?? [])
          .map((r) => normaliseMessageId(r))
          .filter((r): r is string => Boolean(r)),
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        subject: message.subject,
        text: message.text,
        sentAt: new Date(message.sentAt).toISOString(),
        headers: Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
      });
      if (!normalised) continue;
      result.items.push(normalised.item);
      if (normalised.item.kind === "email" && normalised.item.op === "upsert") {
        result.bodies.set(`email:${normalised.item.messageId}`, normalised.body);
      }
    }
    return result;
  },
  async subscribe(session: Session, hook) {
    await session.subscribeChanges(hook);
  },
};

export const fakeCalendarAdapter: SyncAdapter = {
  kind: "calendar",
  async pull(session: Session, cursor, ctx) {
    const page = (await session.listChanges(cursor, ctx.limit)) as {
      items: { id: string; op: "upsert" | "delete" }[];
      next: string | null;
    };
    const result: PullResult = {
      items: [],
      bodies: new Map(),
      cursor: page.next,
      more: page.items.length >= ctx.limit,
      restricted: 0,
    };
    for (const change of page.items) {
      if (change.op === "delete") {
        result.items.push({ kind: "meeting", op: "delete", providerId: change.id });
        continue;
      }
      ctx.tracker.reset();
      let event: {
        id: string;
        uid: string;
        title: string;
        description?: string;
        startsAt: string;
        endsAt?: string;
        location?: string;
        organizer?: { email: string; name?: string };
        attendees: { email: string; name?: string }[];
        cancelled?: boolean;
      };
      try {
        event = await session.getEvent(change.id);
      } catch {
        continue;
      }
      if (ctx.tracker.restricted) {
        result.restricted += 1;
        continue;
      }
      if ((event.endsAt ?? event.startsAt) < ctx.since) continue;
      result.items.push({
        kind: "meeting",
        op: "upsert",
        providerId: event.id,
        uid: event.uid,
        title: event.title,
        description: snippetOf(event.description),
        startsAt: new Date(event.startsAt).toISOString(),
        endsAt: event.endsAt ? new Date(event.endsAt).toISOString() : null,
        location: event.location ?? null,
        organizer: event.organizer ? (addresses([event.organizer])[0] ?? null) : null,
        attendees: addresses(event.attendees),
        cancelled: event.cancelled === true,
      });
    }
    return result;
  },
  async subscribe(session: Session, hook) {
    await session.subscribeChanges(hook);
  },
};

// --- Google: Gmail and Calendar (packages/gatekeeper-google types.d.ts, calendar-types.d.ts) ---

const DAY = 86_400_000;
/** Each backfill pass reads one window of mail or events. */
const WINDOW_DAYS = 7;

interface WindowCursor {
  /** The window still to read starts here (ISO). Backfill walks forward to now. */
  from: string;
}

function windowOf(
  cursor: string | null,
  ctx: PullContext,
): { from: Date; to: Date; next: string; more: boolean } {
  const parsed = cursor ? (JSON.parse(cursor) as WindowCursor) : { from: ctx.since };
  const from = new Date(Math.max(Date.parse(parsed.from), Date.parse(ctx.since)));
  const now = Date.parse(ctx.now);
  const to = new Date(Math.min(from.getTime() + WINDOW_DAYS * DAY, now));
  const more = to.getTime() < now;
  // Catch-up re-reads the last hour so late arrivals are not missed (ingest dedupes).
  const nextFrom = more ? to : new Date(Math.max(to.getTime() - 3_600_000, from.getTime()));
  return { from, to, next: JSON.stringify({ from: nextFrom.toISOString() }), more };
}

export const gmailAdapter: SyncAdapter = {
  kind: "mail",
  async pull(session: Session, cursor, ctx) {
    const w = windowOf(cursor, ctx);
    const query = `after:${Math.floor(w.from.getTime() / 1000)} before:${Math.ceil(w.to.getTime() / 1000)}`;
    const result: PullResult = {
      items: [],
      bodies: new Map(),
      cursor: w.next,
      more: w.more,
      restricted: 0,
    };
    const entries = await session.searchMessages(query);
    let read = 0;
    for (;;) {
      const page = (await entries.next()) as
        | {
            info: {
              id: string;
              from: unknown;
              to: unknown;
              cc: unknown;
              subject: string;
              timestamp: Date;
            };
            message: Session;
          }[]
        | null;
      if (!page) break;
      for (const entry of page) {
        if (read >= ctx.limit * 4) break;
        read += 1;
        ctx.tracker.reset();
        const [headers, content] = await Promise.all([
          entry.message.getHeaders() as Promise<{ name: string; value: string }[]>,
          entry.message.getContent() as Promise<{ text?: string; html?: string }>,
        ]);
        if (ctx.tracker.restricted) {
          result.restricted += 1;
          continue;
        }
        const h = Object.fromEntries(headers.map((x) => [x.name.toLowerCase(), x.value]));
        const text = content.text ?? (content.html ? htmlToText(content.html) : "");
        const normalised = normaliseMail({
          providerId: entry.info.id,
          messageId: normaliseMessageId(h["message-id"]),
          inReplyTo: h["in-reply-to"] ?? null,
          references: parseMessageIds(h.references),
          from: (entry.info.from as { address: string; name?: string } | null)
            ? {
                email: (entry.info.from as { address: string }).address,
                name: (entry.info.from as { name?: string }).name ?? "",
              }
            : null,
          to: addresses(entry.info.to),
          cc: addresses(entry.info.cc),
          subject: entry.info.subject,
          text,
          sentAt: new Date(entry.info.timestamp).toISOString(),
          headers: h,
        });
        if (!normalised) continue;
        result.items.push(normalised.item);
        if (normalised.item.kind === "email" && normalised.item.op === "upsert") {
          result.bodies.set(`email:${normalised.item.messageId}`, normalised.body);
        }
      }
    }
    return result;
  },
  async subscribe(session: Session, hook) {
    await session.subscribeNewMessages(hook);
  },
  async listIds(session: Session, from, to) {
    const query = `after:${Math.floor(from.getTime() / 1000)} before:${Math.ceil(to.getTime() / 1000)}`;
    const { items, complete } = await drainAll<{ info: { id: string } }>(
      await session.searchMessages(query),
      RECONCILE_MAX,
    );
    return { ids: items.map((e) => e.info.id), complete };
  },
};

function calendarTime(
  t: { kind: "date"; date: string } | { kind: "dateTime"; dateTime: Date },
): string {
  return t.kind === "date"
    ? new Date(`${t.date}T00:00:00.000Z`).toISOString()
    : new Date(t.dateTime).toISOString();
}

export const googleCalendarAdapter: SyncAdapter = {
  kind: "calendar",
  async pull(session: Session, cursor, ctx) {
    const w = windowOf(cursor, ctx);
    ctx.tracker.reset();
    const events = (await session.listEvents({
      timeMin: w.from,
      timeMax: w.to,
      includeDescriptions: true,
    })) as {
      id: string;
      title: string;
      start: { kind: "date"; date: string } | { kind: "dateTime"; dateTime: Date };
      end: { kind: "date"; date: string } | { kind: "dateTime"; dateTime: Date };
      status: string;
      location?: string;
      description?: string;
      htmlLink?: string;
      attendees?: { email: string; displayName?: string; organizer?: boolean }[];
    }[];
    // One listEvents call is one observation: restricted means none of it is written.
    if (ctx.tracker.restricted) {
      return {
        items: [],
        bodies: new Map(),
        cursor: w.next,
        more: w.more,
        restricted: events.length,
      };
    }
    const items: SyncItem[] = events.slice(0, 500).map((e) => {
      const attendees = (e.attendees ?? []).map((a) => ({ email: a.email, name: a.displayName }));
      const organizer = e.attendees?.find((a) => a.organizer);
      return {
        kind: "meeting",
        op: "upsert",
        providerId: e.id,
        uid: `google:${e.id}`,
        title: e.title,
        description: snippetOf(e.description),
        startsAt: calendarTime(e.start),
        endsAt: calendarTime(e.end),
        location: e.location ?? null,
        url: e.htmlLink ?? null,
        organizer: organizer ? (addresses([{ email: organizer.email }])[0] ?? null) : null,
        attendees: addresses(attendees),
        cancelled: e.status === "cancelled",
      };
    });
    return { items, bodies: new Map(), cursor: w.next, more: w.more, restricted: 0 };
  },
  async listIds(session: Session, from, to) {
    const events = (await session.listEvents({ timeMin: from, timeMax: to })) as { id: string }[];
    return { ids: events.map((e) => e.id), complete: events.length < 2500 };
  },
};

// --- Microsoft 365: Outlook mail and calendar (gatekeeper-microsoft outlook/calendar-types) ---

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function drain<T>(cursor: { next(): Promise<T[] | null> }, max: number): Promise<T[]> {
  const out: T[] = [];
  while (out.length < max) {
    const page = await cursor.next();
    if (!page?.length) break;
    out.push(...page);
  }
  return out.slice(0, max);
}

/**
 * Outlook exposes no RFC Message-ID, and its message ids differ per mailbox. The dedupe key is a
 * hash of sender, send time and subject, which is the same in every mailbox holding the message.
 */
export const outlookAdapter: SyncAdapter = {
  kind: "mail",
  async pull(session: Session, cursor, ctx) {
    const w = windowOf(cursor, ctx);
    const result: PullResult = {
      items: [],
      bodies: new Map(),
      cursor: w.next,
      more: w.more,
      restricted: 0,
    };
    const list = (await drain(
      await session.listMessages({ since: w.from.toISOString(), pageSize: 50 }),
      ctx.limit * 4,
    )) as {
      id: string;
      conversationId: string;
      subject: string;
      from?: { address: string; name?: string };
      to: { address: string; name?: string }[];
      cc: { address: string; name?: string }[];
      receivedAt: string;
      sentAt?: string;
      isDraft: boolean;
      protection?: string;
    }[];
    for (const info of list) {
      const sent = info.sentAt ?? info.receivedAt;
      if (info.isDraft || info.protection || sent >= w.to.toISOString()) continue;
      ctx.tracker.reset();
      const content = (await session.readMessage(info.id)) as { markdown: string };
      if (ctx.tracker.restricted) {
        result.restricted += 1;
        continue;
      }
      const key = await shortHash(`${info.from?.address ?? ""}|${sent}|${info.subject}`);
      const normalised = normaliseMail({
        providerId: info.id,
        messageId: `outlook.${key}`,
        inReplyTo: null,
        references: [],
        from: info.from ? { email: info.from.address, name: info.from.name ?? "" } : null,
        to: addresses(info.to),
        cc: addresses(info.cc),
        subject: info.subject,
        text: content.markdown ?? "",
        sentAt: new Date(sent).toISOString(),
        headers: {},
      });
      if (!normalised || normalised.item.kind !== "email" || normalised.item.op !== "upsert")
        continue;
      // Outlook's conversation id is per mailbox: threads group within one mailbox only.
      normalised.item.threadKey = `thread:outlook.${info.conversationId}`;
      result.items.push(normalised.item);
      result.bodies.set(`email:${normalised.item.messageId}`, normalised.body);
    }
    return result;
  },
  async subscribe(session: Session, hook) {
    await session.subscribeNewMessages(hook);
  },
  async listIds(session: Session, from, to) {
    const { items, complete } = await drainAll<{ id: string; sentAt?: string; receivedAt: string }>(
      await session.listMessages({ since: from.toISOString(), pageSize: 50 }),
      RECONCILE_MAX,
    );
    const end = to.toISOString();
    return {
      ids: items.filter((m) => (m.sentAt ?? m.receivedAt) < end).map((m) => m.id),
      complete,
    };
  },
};

export const outlookCalendarAdapter: SyncAdapter = {
  kind: "calendar",
  async pull(session: Session, cursor, ctx) {
    const w = windowOf(cursor, ctx);
    ctx.tracker.reset();
    const events = (await drain(
      await session.listEvents({
        start: w.from.toISOString(),
        end: w.to.toISOString(),
        pageSize: 50,
      }),
      500,
    )) as {
      id: string;
      start: string;
      end: string;
      subject?: string;
      location?: string;
      private?: true;
      cancelled?: true;
      organizer?: { address: string; name?: string };
      attendees?: { address?: string; email?: string; name?: string }[];
    }[];
    if (ctx.tracker.restricted) {
      return {
        items: [],
        bodies: new Map(),
        cursor: w.next,
        more: w.more,
        restricted: events.length,
      };
    }
    const items: SyncItem[] = [];
    for (const e of events) {
      // An event its owner marked private stays out of the CRM.
      if (e.private) continue;
      const uid = await shortHash(`${e.organizer?.address ?? ""}|${e.start}|${e.subject ?? ""}`);
      items.push({
        kind: "meeting",
        op: "upsert",
        providerId: e.id,
        uid: `outlook.${uid}`,
        title: e.subject ?? null,
        startsAt: new Date(e.start).toISOString(),
        endsAt: new Date(e.end).toISOString(),
        location: e.location ?? null,
        organizer: e.organizer ? (addresses([e.organizer])[0] ?? null) : null,
        attendees: addresses(e.attendees ?? []),
        cancelled: e.cancelled === true,
      });
    }
    return { items, bodies: new Map(), cursor: w.next, more: w.more, restricted: 0 };
  },
  async listIds(session: Session, from, to) {
    const { items, complete } = await drainAll<{ id: string }>(
      await session.listEvents({ start: from.toISOString(), end: to.toISOString(), pageSize: 50 }),
      RECONCILE_MAX,
    );
    return { ids: items.map((e) => e.id), complete };
  },
};

/** The adapter for a vendor's resource, if sync supports it. */
export function adapterFor(vendor: string, kind: SyncKind): SyncAdapter | null {
  if (vendor === "fake") return kind === "mail" ? fakeMailAdapter : fakeCalendarAdapter;
  if (vendor === "google") return kind === "mail" ? gmailAdapter : googleCalendarAdapter;
  if (vendor === "microsoft") return kind === "mail" ? outlookAdapter : outlookCalendarAdapter;
  return null;
}
