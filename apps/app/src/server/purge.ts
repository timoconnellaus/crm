// The scheduled Trash purge (cron trigger in wrangler.jsonc). Framework-free so it is tested
// directly in workerd; src/server.ts calls it from the Worker's `scheduled` handler. It runs
// trash.purge through the operations pipeline as an automation (SYSTEM_USER, origin `system`),
// so every round is gated by the approval policy and floor, and audited.
import {
  compactPendingActions,
  drainAllBlobDeletions,
  errorForLog,
  expirePendingActions,
  measureStorage,
  parseFloor,
  purgeIntegrationEvents,
  purgeNotificationDeliveries,
  purgeNotifications,
  purgeRunHistory,
  queueEventSink,
  runAuditPurge,
  runTrashPurge,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { blobStoreFor, integrationRuntimeFor } from "./integrations.ts";

export interface PurgeEnv {
  DB: D1Database;
  APPROVAL_FLOOR?: string;
  /** ros-runner: expired outbound items are dropped on their gatekeepers. */
  RUNNER?: Fetcher;
  /** Expired approvals wake the automation runs waiting on them (ADR 0130). */
  AUTOMATION_EVENTS?: Queue;
}

export async function runScheduledPurge(env: PurgeEnv, clock?: () => Date) {
  const result = await runTrashPurge(createCrmDb(env.DB), {
    floor: parseFloor(env.APPROVAL_FLOOR),
    ...(clock ? { clock } : {}),
  });
  console.log(
    `trash purge: ${result.purged} record(s) in ${result.rounds} round(s)${result.more ? ", more due" : ""}`,
  );
  return result;
}

/**
 * The daily cron: the Trash purge, expiring pending approvals, then storage retention (ADR 0090):
 * the audit retention purge, run history, compacting old pending actions, and measuring the
 * database for the storage gauge. Each step is chunked and bounded; what is left is picked up
 * the next day. A failing step is logged and does not stop the others.
 */
export async function runScheduledMaintenance(env: PurgeEnv, clock?: () => Date) {
  const purge = await runScheduledPurge(env, clock);
  const db = createCrmDb(env.DB);
  const now = (clock?.() ?? new Date()).toISOString();
  const expired = await expirePendingActions(
    db,
    now,
    integrationRuntimeFor(env),
    env.AUTOMATION_EVENTS ? queueEventSink(env.AUTOMATION_EVENTS) : undefined,
  );
  if (expired) console.log(`approvals: ${expired} pending action(s) expired`);

  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      console.error(`maintenance: ${name} failed`, error);
      return null;
    }
  };
  const audit = await step("audit purge", () =>
    runAuditPurge(db, { floor: parseFloor(env.APPROVAL_FLOOR), ...(clock ? { clock } : {}) }),
  );
  if (audit?.rounds) {
    console.log(
      `audit retention: ${audit.auditRows} audit row(s), ${audit.changeRows} change row(s), ` +
        `${audit.readCountRows} read count row(s)${audit.more ? ", more due" : ""}`,
    );
  }
  const runs = await step("run history", () => purgeRunHistory(db.query, now));
  if (runs?.deleted) console.log(`run history: ${runs.deleted} run(s) purged`);
  const compacted = await step("pending action compaction", () =>
    compactPendingActions(db.query, now),
  );
  if (compacted?.compacted) console.log(`approvals: ${compacted.compacted} action(s) compacted`);
  const storage = await step("storage measurement", () => measureStorage(db, now));
  // Inbound events are kept 90 days (stage 5 consumes them well within that).
  const events = await step("integration events", () =>
    purgeIntegrationEvents(db, { now: clock?.() ?? new Date() }),
  );
  // Notifications are kept 90 days (ADR 0132).
  const notifications = await step("notifications", () => purgeNotifications(db.query, now));
  if (notifications?.deleted) console.log(`notifications: ${notifications.deleted} purged`);
  // Their delivery ledger goes with them (ADR 0172).
  await step("notification deliveries", () => purgeNotificationDeliveries(db.query, now));
  return { purge, expired, audit, runs, compacted, storage, events, notifications };
}

/**
 * The 10-minute cron's blob step (ADR 0320): deletes the R2 objects (synced email bodies) that
 * erases, the Trash purge and sync queued in core_blob_deletion, retrying what the post-commit
 * drain missed. Never throws.
 */
export async function runBlobDeletionCron(env: { DB: D1Database; BLOBS?: R2Bucket }) {
  const blobs = blobStoreFor(env);
  if (!blobs) return null;
  try {
    const result = await drainAllBlobDeletions(createCrmDb(env.DB).query, blobs, 20);
    if (result.deleted || result.failed) {
      console.log(`blob deletions: ${result.deleted} deleted, ${result.failed} failed`);
    }
    return result;
  } catch (error) {
    console.error("blob deletion drain failed", errorForLog(error));
    return null;
  }
}
