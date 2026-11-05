// The delivery ledger (core_notification_delivery, migration 0172, ADR 0172): every external send
// is claimed under a key before it is made (INSERT OR IGNORE on the primary key), then settled as
// sent, pending (an outbound action waiting for approval) or failed. A repeated cron tick or a
// redelivered event finds the key taken and sends nothing. A crash between claim and settle
// leaves `sending`: the send is never retried (at most once, rather than twice).
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import type { DeliveryOutcome, ExternalChannelId } from "./types.ts";

export type DeliveryKind = "notification" | "escalation" | "digest" | "route";

export interface DeliveryResult {
  key: string;
  status: DeliveryOutcome["status"] | "failed" | "duplicate";
  detail?: string;
}

/** Claims `key`; false when it was already claimed (sent, pending, failed or in flight). */
export async function claimDelivery(
  db: Kysely<CoreDatabase>,
  entry: {
    key: string;
    kind: DeliveryKind;
    channel: ExternalChannelId;
    userId?: string | null;
    status?: "sending" | "skipped";
    detail?: string | null;
  },
  now: string,
): Promise<boolean> {
  const result = await db
    .insertInto("core_notification_delivery")
    .orIgnore()
    .values({
      key: entry.key,
      kind: entry.kind,
      channel: entry.channel,
      user_id: entry.userId ?? null,
      status: entry.status ?? "sending",
      detail: entry.detail ?? null,
      created_at: now,
    })
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/** Settles a claimed key with what the send came to (an error is `failed`, with its message). */
export async function settleDelivery(
  db: Kysely<CoreDatabase>,
  key: string,
  outcome: DeliveryOutcome | unknown,
): Promise<DeliveryResult> {
  const result: DeliveryResult = isOutcome(outcome)
    ? { key, status: outcome.status, ...(outcome.detail ? { detail: outcome.detail } : {}) }
    : {
        key,
        status: "failed",
        detail: (outcome instanceof Error ? outcome.message : String(outcome)).slice(0, 500),
      };
  try {
    await db
      .updateTable("core_notification_delivery")
      .set({ status: result.status as "sent", detail: result.detail ?? null })
      .where("key", "=", key)
      .execute();
  } catch (error) {
    console.error(`notification delivery ${key}: could not record ${result.status}`, error);
  }
  return result;
}

function isOutcome(value: unknown): value is DeliveryOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    ["sent", "pending", "skipped"].includes((value as { status: string }).status)
  );
}

/** Retention: ledger rows go with the notifications, after 90 days (ADR 0090). */
export async function purgeNotificationDeliveries(
  db: Kysely<CoreDatabase>,
  now: string,
  {
    chunk = 500,
    maxChunks = 20,
    days = 90,
  }: { chunk?: number; maxChunks?: number; days?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
  let deleted = 0;
  for (let i = 0; i < maxChunks; i++) {
    const result = await db
      .deleteFrom("core_notification_delivery")
      .where("key", "in", (eb) =>
        eb
          .selectFrom("core_notification_delivery")
          .select("key")
          .where("created_at", "<", cutoff)
          .orderBy("created_at")
          .limit(chunk),
      )
      .executeTakeFirst();
    const n = Number(result.numDeletedRows ?? 0);
    deleted += n;
    if (n < chunk) return { deleted, more: false };
  }
  return { deleted, more: true };
}
