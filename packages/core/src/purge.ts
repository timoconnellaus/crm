// The scheduled Trash purge (stage 1): hard-deletes records soft-deleted more than 30 days ago by
// calling `trash.purge` through the pipeline as an automation, so every round is gated and
// audited like any other operation. A Worker's `scheduled` handler calls runTrashPurge.
import type { CrmDb } from "@relationship-os/db";
import type { GateFloor } from "./gate.ts";
import { invoke } from "./invoke.ts";
import { PURGE_MAX } from "./operations/trash.ts";
import { SYSTEM_USER } from "./users.ts";

export interface TrashPurgeOptions {
  floor?: GateFloor;
  clock?: () => Date;
  /** Upper bound on rounds per run; the next run picks up anything left. Default 20. */
  maxRounds?: number;
}

/** Runs trash.purge until nothing more is due (or maxRounds). Returns how many were purged. */
export async function runTrashPurge(
  db: CrmDb,
  { floor, clock, maxRounds = 20 }: TrashPurgeOptions = {},
): Promise<{ purged: number; rounds: number; more: boolean }> {
  let purged = 0;
  let rounds = 0;
  let more = true;
  while (more && rounds < maxRounds) {
    rounds += 1;
    const result = await invoke(
      "trash.purge",
      { limit: PURGE_MAX },
      {
        actor: "automation",
        user: SYSTEM_USER,
        origin: { surface: "system", automationId: "trash.purge" },
        db,
        ...(floor ? { floor } : {}),
        ...(clock ? { clock } : {}),
      },
    );
    purged += result.purged.length;
    more = result.more;
  }
  return { purged, rounds, more };
}
