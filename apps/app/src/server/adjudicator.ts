// The policy adjudicator's catch-up sweep (ADR 0204), on the 10-minute cron: judges pending
// actions the post-queue hook missed (it ran out of time, or ros-runner queued them). Framework-
// free so it is tested in workerd. With the adjudicator off it is one settings read.
import { coreRegistry, parseFloor, runAdjudicatorSweep } from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { judgeOf, modelsFor } from "./ai.ts";
import { automationWiring, extensionHostFor, type OperationsEnv } from "./operations.ts";

export async function runAdjudicatorCron(env: OperationsEnv, clock?: () => Date) {
  try {
    const db = createCrmDb(env.DB);
    const models = modelsFor(env, db);
    const extensionHost = extensionHostFor(env);
    const { events } = automationWiring(env);
    const result = await runAdjudicatorSweep({
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      resolveOperation: (name) => coreRegistry.get(name),
      ...(models ? { models } : {}),
      // The Jev reviewer (ADR 0233) when the judge has a key.
      judge: judgeOf(env, db),
      ...(extensionHost ? { extensionHost } : {}),
      ...(events ? { events } : {}),
      ...(clock ? { clock } : {}),
    });
    if (result.judged) console.log(`policy adjudicator: ${result.judged} verdict(s) caught up`);
    return result;
  } catch (error) {
    console.error("policy adjudicator sweep failed", error);
    return null;
  }
}
