// Inbound events for stage 5 (ADR 0113): verified webhook deliveries and sync events. The
// integration host records webhook events as they arrive; sync.ingest records sync events in its
// own batch. Stage 5 turns them into automation triggers and sets `consumed_at`.
import type { CrmDb } from "@relationship-os/db";
import type { Compilable } from "kysely";
import { newId } from "../ids.ts";

export interface IntegrationEventInput {
  source: "webhook" | "sync";
  connectionId: string | null;
  type: string;
  /** The provider's delivery id; a repeated one is ignored. */
  externalId?: string | null | undefined;
  payload: unknown;
  occurredAt: string;
}

/** Events larger than this are stored as a stub saying so (D1 rows stay small). */
export const EVENT_PAYLOAD_MAX_BYTES = 64_000;

export function eventInsert(db: CrmDb, event: IntegrationEventInput, now: string): Compilable {
  let payload = JSON.stringify(event.payload ?? null);
  if (payload.length > EVENT_PAYLOAD_MAX_BYTES) {
    payload = JSON.stringify({ truncated: true, bytes: payload.length });
  }
  return db.query
    .insertInto("core_integration_event")
    .values({
      id: newId("integrationEvent"),
      source: event.source,
      connection_id: event.connectionId,
      type: event.type.slice(0, 200),
      external_id: event.externalId?.slice(0, 500) ?? null,
      payload,
      occurred_at: event.occurredAt,
      created_at: now,
    })
    .onConflict((oc) => oc.doNothing());
}

/** Records events in one batch. Returns how many were given (duplicates are ignored). */
export async function recordIntegrationEvents(
  db: CrmDb,
  events: readonly IntegrationEventInput[],
  now: string = new Date().toISOString(),
): Promise<number> {
  if (!events.length) return 0;
  await db.batch(events.map((e) => eventInsert(db, e, now)));
  return events.length;
}

/** Deletes events older than `days` (default 90), at most `limit` per call. Daily cron. */
export async function purgeIntegrationEvents(
  db: CrmDb,
  { days = 90, limit = 5000, now = new Date() }: { days?: number; limit?: number; now?: Date } = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const result = await db.query
    .deleteFrom("core_integration_event")
    .where(
      "id",
      "in",
      db.query
        .selectFrom("core_integration_event")
        .select("id")
        .where("created_at", "<", cutoff)
        .orderBy("created_at")
        .limit(limit),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
