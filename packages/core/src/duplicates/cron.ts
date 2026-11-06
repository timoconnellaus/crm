// The duplicate scan's cron step (stage 16, ADR 0247), kept apart from scan.ts so the operations
// never import the registry (invoke.ts) they are part of.
import type { CrmDb } from "@relationship-os/db";
import { zonedTime } from "../automations/cron.ts";
import { invoke } from "../invoke.ts";
import { loadGeneralSettings } from "../settings.ts";
import { SYSTEM_USER } from "../users.ts";
import { loadScanState, nightlyDue, type ScanMode, scanPending } from "./scan.ts";

/**
 * ros-runner's minute cron: carries on pending work (the backfill, a full scan, a backlog) one
 * bounded call per tick, and runs the incremental scan once a night (02:00 or later in the org's
 * timezone). Runs `duplicate.scan` through the pipeline as the system, so each call is audited.
 * One settings read on a quiet tick.
 */
export async function runDuplicateCron(
  db: CrmDb,
  at: Date,
): Promise<{ mode: ScanMode | null; done?: boolean }> {
  const state = await loadScanState(db.query);
  let mode: ScanMode | null = null;
  if (scanPending(state)) {
    mode = "continue";
  } else {
    const { timezone } = await loadGeneralSettings(db.query);
    const local = zonedTime(at, timezone);
    if (nightlyDue(state, local.date, local.hour)) mode = "incremental";
  }
  if (!mode) return { mode };
  const result = await invoke(
    "duplicate.scan",
    { mode },
    {
      actor: "automation",
      user: SYSTEM_USER,
      origin: { surface: "system", automationId: "duplicate.scan" },
      db,
      clock: () => at,
    },
  );
  return { mode, done: result.done };
}
