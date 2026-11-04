// Notification retention (ADR 0132, ADR 0090): notifications are kept 90 days, read or not. The
// daily maintenance cron calls purgeNotifications; each statement deletes the oldest `chunk` rows
// through core_notifications_created_idx, so no run scans the table (test/notifications.test.ts).
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";

export const NOTIFICATION_RETENTION_DAYS = 90;

export async function purgeNotifications(
  db: Kysely<CoreDatabase>,
  now: string,
  { chunk = 500, maxChunks = 20 }: { chunk?: number; maxChunks?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const cutoff = new Date(Date.parse(now) - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();
  let deleted = 0;
  for (let i = 0; i < maxChunks; i++) {
    const result = await db
      .deleteFrom("core_notifications")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("core_notifications")
          .select("id")
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
