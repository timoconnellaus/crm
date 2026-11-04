// The self-updater's port (ADR 0054, ADR 0164). update.* operations read and write the
// deployment's release state in D1 and call this port for everything that leaves the Worker:
// GitHub Releases (read-only, public) and the Cloudflare API (with the stored scoped token). crm-app
// implements it in src/server/updater.ts; tests pass a fake.
import type { CoreDatabase } from "@crm/db";
import type {
  AutomationControl,
  Channel,
  DeploymentState,
  PreflightResult,
  ReleaseInfo,
  ReleaseManifest,
  RunRecord,
  UpdateOutcome,
} from "@crm/release";
import type { Kysely } from "kysely";

export type { AutomationControl } from "@crm/release";

export interface UpdaterRuntime {
  /** The installed release (env CRM_RELEASE_VERSION), or null for a source deploy. */
  readonly currentVersion: string | null;
  /** GitHub owner/repo releases are read from. */
  readonly repository: string;
  /** Whether a scoped update token (CRM_UPDATE_TOKEN) and the account id are configured. */
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
 * Pausing automations during an update. Stage 5 (automations) replaces this with one that holds
 * scheduled and event-triggered runs and resumes them after; until then there is nothing to pause.
 */
export function automationControlFor(_db: Kysely<CoreDatabase>): AutomationControl {
  return { async pause() {}, async resume() {} };
}

export type { PreflightResult };
