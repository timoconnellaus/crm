// Integration events → automation runs (ADR 0173). Stage 6a records verified webhook deliveries
// and sync events in core_integration_event; this minute-cron step reads the unconsumed ones
// through core_integration_event_unconsumed_idx, dispatches them like queue messages (the
// `integration` trigger source) and sets `consumed_at`.
//
// - At most POLL_BATCH rows per read and POLL_MAX_BATCHES reads per tick, so a burst drains over a
//   few minutes without one tick running long.
// - A sync event whose activity is private (marked by its mailbox owner, ADR 0112) or gone is
//   consumed without dispatching: private content never reaches a trigger.
// - When dispatch throws, the batch stays unconsumed and the next tick tries again; runs are
//   idempotent per event id, so a partly dispatched batch starts nothing twice.
// - With nothing waiting, a tick costs one indexed read that returns no rows.
import {
  type IntegrationEventMessage,
  type IntegrationEventRow,
  integrationEventMessage,
  jsonList,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { type DispatchEnv, dispatchAutomationMessages, type StartResult } from "./dispatch.ts";

export const POLL_BATCH = 100;
export const POLL_MAX_BATCHES = 5;

export interface PollResult {
  /** Events read and consumed. */
  consumed: number;
  /** Of those, dispatched (the rest were private or had no activity). */
  dispatched: number;
  runIds: string[];
}

/** Reads, dispatches and consumes unconsumed integration events. */
export async function pollIntegrationEvents(
  env: DispatchEnv,
  options: { now?: Date; batch?: number; maxBatches?: number } = {},
): Promise<PollResult> {
  const crm = createCrmDb(env.DB);
  const db = crm.query;
  const result: PollResult = { consumed: 0, dispatched: 0, runIds: [] };
  const batch = options.batch ?? POLL_BATCH;
  for (let round = 0; round < (options.maxBatches ?? POLL_MAX_BATCHES); round++) {
    const rows = (await db
      .selectFrom("core_integration_event")
      .select(["id", "source", "connection_id", "type", "payload", "occurred_at", "created_at"])
      .where("consumed_at", "is", null)
      .orderBy("id")
      .limit(batch)
      .execute()) as IntegrationEventRow[];
    if (!rows.length) break;
    const messages = await withoutPrivate(
      db,
      rows.map((row) => integrationEventMessage(row)),
    );
    let started: StartResult | null = null;
    if (messages.length) {
      started = await dispatchAutomationMessages(
        env,
        messages,
        options.now ? { now: options.now } : {},
      );
    }
    const at = (options.now ?? new Date()).toISOString();
    await db
      .updateTable("core_integration_event")
      .set({ consumed_at: at })
      .where("id", "in", jsonList(rows.map((r) => r.id)))
      .where("consumed_at", "is", null)
      .execute();
    result.consumed += rows.length;
    result.dispatched += messages.length;
    if (started) result.runIds.push(...started.runIds);
    if (rows.length < batch) break;
  }
  return result;
}

/** Drops sync events whose activity is private or missing (one PK read per batch). */
async function withoutPrivate(
  db: ReturnType<typeof createCrmDb>["query"],
  messages: IntegrationEventMessage[],
): Promise<IntegrationEventMessage[]> {
  const activityIds = new Set<string>();
  for (const m of messages) {
    const id = (m.payload as { activityId?: unknown } | null)?.activityId;
    if (m.source === "sync" && typeof id === "string") activityIds.add(id);
  }
  if (!activityIds.size) return messages;
  const rows = await db
    .selectFrom("core_activity")
    .select(["id", "private_to"])
    .where("id", "in", jsonList([...activityIds]))
    .execute();
  const shared = new Set(rows.filter((r) => r.private_to === null).map((r) => r.id));
  return messages.filter((m) => {
    if (m.source !== "sync") return true;
    const id = (m.payload as { activityId?: unknown } | null)?.activityId;
    return typeof id === "string" && shared.has(id);
  });
}
