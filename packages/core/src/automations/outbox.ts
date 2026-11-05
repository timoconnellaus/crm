// The automation events outbox (ADR 0171). Stage 5 sent events after commit and only logged a
// failed send, so a queue hiccup lost them. Now an operation that changes records writes its
// events into core_automation_outbox in the same D1 batch as the change, sends them after commit
// and deletes the row; ros-runner's minute cron retries rows that are still there, with backoff.
//
// Cost: one row insert and one delete per event-producing operation (never per read, never per
// record: a 5,000-record import is one or a few rows). The cron reads at most one page of the
// table by primary key, which is empty unless sends are failing.
//
// Delivery is at least once (a send that succeeded but whose delete was lost is sent again);
// runs are exactly once per event id (ADR 0130: the Workflow id is derived from it).
import type { CrmDb } from "@relationship-os/db";
import type { Compilable } from "kysely";
import { newId } from "../ids.ts";
import type { AutomationQueueMessage, EventSink } from "./types.ts";

/** One outbox row holds at most this much JSON (D1 rows and values stop at 2 MB). */
export const OUTBOX_ROW_MAX_BYTES = 900_000;
/** The cron leaves a fresh row alone this long: the post-commit send is still in flight. */
export const OUTBOX_GRACE_MS = 60_000;
/** Backoff after the n-th failed attempt: 1, 2, 4, … minutes, at most an hour. */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}
/** Rows the cron takes per tick. */
export const OUTBOX_PAGE = 50;
/** After this many failed attempts a row is kept but logged loudly at every try. */
export const OUTBOX_WARN_ATTEMPTS = 10;

export interface OutboxEntry {
  id: string;
  messages: AutomationQueueMessage[];
}

/** Splits one operation's messages into outbox rows (usually one). */
export function outboxEntries(messages: readonly AutomationQueueMessage[]): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  let chunk: AutomationQueueMessage[] = [];
  let bytes = 2;
  for (const message of messages) {
    const size = JSON.stringify(message).length + 1;
    if (chunk.length && bytes + size > OUTBOX_ROW_MAX_BYTES) {
      entries.push({ id: newId("outbox"), messages: chunk });
      chunk = [];
      bytes = 2;
    }
    chunk.push(message);
    bytes += size;
  }
  if (chunk.length) entries.push({ id: newId("outbox"), messages: chunk });
  return entries;
}

/** The inserts for `entries`, for the caller's own batch (committed with the change). */
export function outboxInserts(
  db: CrmDb,
  entries: readonly OutboxEntry[],
  now: string,
): Compilable[] {
  const nextAt = new Date(Date.parse(now) + OUTBOX_GRACE_MS).toISOString();
  return entries.map((entry) =>
    db.query.insertInto("core_automation_outbox").values({
      id: entry.id,
      messages: JSON.stringify(entry.messages),
      attempts: 0,
      next_at: nextAt,
      last_error: null,
      created_at: now,
    }),
  );
}

/**
 * Sends committed outbox entries and deletes each one that was sent. A failed send is logged and
 * left for the cron; it never fails the caller (the change is committed).
 */
export async function deliverOutbox(
  db: CrmDb,
  sink: EventSink,
  entries: readonly OutboxEntry[],
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      await sink.send(entry.messages);
    } catch (error) {
      failed += 1;
      console.error("automation events: send failed; the outbox retries it", entry.id, error);
      continue;
    }
    sent += 1;
    try {
      await db.query.deleteFrom("core_automation_outbox").where("id", "=", entry.id).execute();
    } catch (error) {
      // Sent but not deleted: the cron sends it again; runs are idempotent per event id.
      console.warn("automation events: sent, but the outbox row stays", entry.id, error);
    }
  }
  return { sent, failed };
}

/**
 * For events decided after a commit (approval decisions): writes the outbox row, then sends.
 * Without a sink nothing is written (tests and scripts without a queue emit nothing).
 */
export async function emitDurably(
  db: CrmDb,
  sink: EventSink | undefined,
  messages: AutomationQueueMessage[],
  now: string = new Date().toISOString(),
): Promise<void> {
  if (!sink || !messages.length) return;
  const entries = outboxEntries(messages);
  try {
    await db.batch(outboxInserts(db, entries, now));
  } catch (error) {
    // The outbox itself failed: fall back to a plain send (stage 5's behaviour).
    console.error("automation events: outbox write failed; sending without it", error);
    try {
      await sink.send(messages);
    } catch (sendError) {
      console.error("automation events: send failed", messages[0]?.id, sendError);
    }
    return;
  }
  await deliverOutbox(db, sink, entries);
}

export interface OutboxRetryResult {
  /** Rows sent and deleted. */
  sent: number;
  /** Rows whose send failed again (rescheduled with backoff). */
  failed: number;
  /** Rows looked at (due or not). */
  read: number;
}

/**
 * The cron's retry: up to OUTBOX_PAGE rows in id (time) order; those due are handed to `send`
 * (ros-runner dispatches them directly, so a queue outage does not block it), deleted on success
 * and rescheduled with backoff on failure.
 */
export async function retryOutbox(
  db: CrmDb,
  send: (messages: AutomationQueueMessage[]) => Promise<void>,
  options: { now?: Date; limit?: number } = {},
): Promise<OutboxRetryResult> {
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const rows = await db.query
    .selectFrom("core_automation_outbox")
    .select(["id", "messages", "attempts", "next_at"])
    .orderBy("id")
    .limit(options.limit ?? OUTBOX_PAGE)
    .execute();
  const result: OutboxRetryResult = { sent: 0, failed: 0, read: rows.length };
  for (const row of rows) {
    if (row.next_at > iso) continue;
    let messages: AutomationQueueMessage[];
    try {
      messages = JSON.parse(row.messages) as AutomationQueueMessage[];
    } catch {
      messages = [];
    }
    try {
      if (messages.length) await send(messages);
      await db.query.deleteFrom("core_automation_outbox").where("id", "=", row.id).execute();
      result.sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      (attempts >= OUTBOX_WARN_ATTEMPTS ? console.error : console.warn)(
        `automation events: outbox row ${row.id} failed (attempt ${attempts})`,
        message,
      );
      await db.query
        .updateTable("core_automation_outbox")
        .set({
          attempts,
          next_at: new Date(now.getTime() + outboxBackoffMs(attempts)).toISOString(),
          last_error: message.slice(0, 1000),
        })
        .where("id", "=", row.id)
        .execute();
    }
  }
  return result;
}
