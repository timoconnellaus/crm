// The self-updater's port (ADR 0054, ADR 0164). update.* operations read and write the
// deployment's release state in D1 and call this port for everything that leaves the Worker:
// GitHub Releases (read-only, public) and the Cloudflare API (with the stored scoped token). ros-app
// implements it in src/server/updater.ts; tests pass a fake.
import type { CoreDatabase } from "@relationship-os/db";
import type {
  AutomationControl,
  Channel,
  DeploymentState,
  PreflightResult,
  ReleaseInfo,
  ReleaseManifest,
  RunRecord,
  UpdateOutcome,
} from "@relationship-os/release";
import { killSwitchControl } from "@relationship-os/release";
import type { Kysely } from "kysely";
import { AUTOMATION_SETTINGS } from "./automations/types.ts";

const KILL_SWITCH_SETTING = AUTOMATION_SETTINGS.killSwitch;

export type { AutomationControl } from "@relationship-os/release";

export interface UpdaterRuntime {
  /** The installed release (env ROS_RELEASE_VERSION), or null for a source deploy. */
  readonly currentVersion: string | null;
  /** GitHub owner/repo releases are read from. */
  readonly repository: string;
  /** Whether a scoped update token (ROS_UPDATE_TOKEN) and the account id are configured. */
  readonly canUpdate: boolean;
  /** Published releases visible on `channel`, newest first (uncached; the operation caches). */
  listReleases(channel: Channel): Promise<ReleaseInfo[]>;
  /** A release's manifest (from its release asset), for preflight. Null when unavailable. */
  manifest(version: string): Promise<ReleaseManifest | null>;
  /** Secret names set on each deployed Worker, or undefined without a token. */
  secretsSet(state: DeploymentState): Promise<Record<string, string[]> | undefined>;
  /**
   * Downloads and verifies `version` (refusing a tampered bundle), then runs the update procedure.
   * `record` persists the run row outside the operation's own batch (and again after a restore).
   */
  apply(input: {
    version: string;
    state: DeploymentState;
    run: RunRecord;
    record: (run: RunRecord) => Promise<void>;
    automations: AutomationControl;
  }): Promise<UpdateOutcome>;
  /** Redeploys `run.from_version` and restores `run.bookmark`. */
  rollback(input: {
    run: RunRecord;
    state: DeploymentState;
    automations: AutomationControl;
  }): Promise<void>;
}

/**
 * Pausing automations during an update with Stage 5's kill switch (ADR 0164 amendment): reversible,
 * so a switch an admin had already turned on stays on. Written directly, outside the update
 * operation's batch, because it must take effect before migrations start.
 */
export function automationControlFor(db: Kysely<CoreDatabase>): AutomationControl {
  return killSwitchControl({
    async read() {
      const row = await db
        .selectFrom("core_settings")
        .select("value")
        .where("key", "=", KILL_SWITCH_SETTING)
        .executeTakeFirst();
      try {
        return row ? JSON.parse(row.value) === true : false;
      } catch {
        return false;
      }
    },
    async write(on) {
      const value = JSON.stringify(on);
      const now = new Date().toISOString();
      await db
        .insertInto("core_settings")
        .values({ key: KILL_SWITCH_SETTING, value, updated_at: now, updated_by: null })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
        .execute();
    },
  });
}

export type { PreflightResult };
