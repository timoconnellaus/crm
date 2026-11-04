// The scheduled Trash purge (cron trigger in wrangler.jsonc). Framework-free so it is tested
// directly in workerd; src/server.ts calls it from the Worker's `scheduled` handler. It runs
// trash.purge through the operations pipeline as an automation (SYSTEM_USER, origin `system`),
// so every round is gated by the approval policy and floor, and audited.
import {
  compactPendingActions,
  expirePendingActions,
  measureStorage,
  parseFloor,
  purgeIntegrationEvents,
  purgeRunHistory,
  runAuditPurge,
  runTrashPurge,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { integrationRuntimeFor } from "./integrations.ts";

export interface PurgeEnv {
  DB: D1Database;
  APPROVAL_FLOOR?: string;
  /** crm-runner: expired outbound items are dropped on their gatekeepers. */
  RUNNER?: Fetcher;
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
  const expired = await expirePendingActions(db.query, now, integrationRuntimeFor(env));
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
  return { purge, expired, audit, runs, compacted, storage, events };
}
