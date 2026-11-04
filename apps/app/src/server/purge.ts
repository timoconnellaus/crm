// The scheduled Trash purge (cron trigger in wrangler.jsonc). Framework-free so it is tested
// directly in workerd; src/server.ts calls it from the Worker's `scheduled` handler. It runs
// trash.purge through the operations pipeline as an automation (SYSTEM_USER, origin `system`),
// so every round is gated by the approval policy and floor, and audited.
import { expirePendingActions, parseFloor, pruneRateLimits, runTrashPurge } from "@crm/core";
import { createCrmDb } from "@crm/db";

export interface PurgeEnv {
  DB: D1Database;
  APPROVAL_FLOOR?: string;
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

/** The daily cron: the Trash purge, then expiring pending approvals and old rate-limit windows. */
export async function runScheduledMaintenance(env: PurgeEnv, clock?: () => Date) {
  const purge = await runScheduledPurge(env, clock);
  const db = createCrmDb(env.DB);
  const now = (clock?.() ?? new Date()).toISOString();
  const expired = await expirePendingActions(db.query, now);
  await pruneRateLimits(db.query, now);
  if (expired) console.log(`approvals: ${expired} pending action(s) expired`);
  return { purge, expired };
}
