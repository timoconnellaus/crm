// The upgrade and rollback procedures (ADR 0054, ADR 0164), shared by the self-updater and
// `crm upgrade` so both do exactly the same thing:
//
//   1. pause automations          (AutomationControl; a no-op until stage 5 lands)
//   2. take a D1 Time Travel bookmark
//   3. apply core migrations
//   4. switch all Workers together
//   5. smoke check the new version
//   6. resume automations
//
// A failure in 3 restores the bookmark (no Worker has changed yet). A failure in 4 or 5
// redeploys the previous release's bundle and restores the bookmark. Automations are resumed
// whatever happens.
//
// Restoring the bookmark rewinds the whole database, including any record of this update kept
// there, so callers re-record the run in `onStep("restored")`.
import type { ReleaseBundle } from "./bundle.ts";
import type { CloudflareClient } from "./cloudflare.ts";
import {
  applyBundleMigrations,
  type DeploymentState,
  deployWorkers,
  type Log,
  type MigrationRunner,
  writeDeploymentState,
} from "./deploy.ts";

/** Pauses and resumes automations around an update. Stage 5 provides the real one. */
export interface AutomationControl {
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export const noAutomationControl: AutomationControl = {
  async pause() {},
  async resume() {},
};

export type UpdateStep =
  | "pause"
  | "bookmark"
  | "migrate"
  | "switch"
  | "smoke"
  | "resume"
  | "rollback"
  | "restored"
  | "done";

export interface UpdateOutcome {
  status: "succeeded" | "rolled_back" | "failed";
  from: string;
  to: string;
  bookmark: string | null;
  migrations: string[];
  error?: string;
  /** Set when even the rollback failed: the deployment needs an operator. */
  rollbackError?: string;
}

export interface UpdateInput {
  api: CloudflareClient;
  state: DeploymentState;
  databaseId: string;
  target: ReleaseBundle;
  targetDigest?: string;
  /** The installed release's bundle, for rolling back after a failed switch. */
  previous: () => Promise<ReleaseBundle | null>;
  migrations: MigrationRunner;
  automations?: AutomationControl;
  /** Throws when the new version is not healthy. */
  smoke: (hostname: string, version: string) => Promise<void>;
  /** Called as each step starts (and with "restored" after a restore). */
  onStep?: (step: UpdateStep, outcome?: Partial<UpdateOutcome>) => Promise<void> | void;
  secrets?: Record<string, Record<string, string>>;
  log?: Log;
}

export async function runUpdate(input: UpdateInput): Promise<UpdateOutcome> {
  const log = input.log ?? (() => {});
  const automations = input.automations ?? noAutomationControl;
  const { api, state, databaseId, target } = input;
  const outcome: UpdateOutcome = {
    status: "failed",
    from: state.version,
    to: target.manifest.version,
    bookmark: null,
    migrations: [],
  };
  const step = async (name: UpdateStep) => {
    log(`${name}…`);
    await input.onStep?.(name, outcome);
  };

  let phase: "before" | "migrated" | "switched" = "before";
  try {
    await step("pause");
    await automations.pause();

    await step("bookmark");
    outcome.bookmark = await api.d1Bookmark(state.accountId, databaseId);

    await step("migrate");
    outcome.migrations = await applyBundleMigrations(target, input.migrations, log);
    phase = "migrated";

    await step("switch");
    await deployWorkers({ api, bundle: target, state, secrets: input.secrets ?? {}, log });
    phase = "switched";

    await step("smoke");
    await input.smoke(state.hostname, target.manifest.version);

    const next: DeploymentState = {
      ...state,
      version: target.manifest.version,
      ...(input.targetDigest ? { bundleDigest: input.targetDigest } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeDeploymentState(api, databaseId, next);
    outcome.status = "succeeded";
  } catch (error) {
    outcome.error = (error as Error).message;
    log(`update failed: ${outcome.error}`);
    if (outcome.bookmark) {
      await step("rollback");
      try {
        if (phase === "switched" || phase === "migrated") {
          const previous = await input.previous();
          if (previous) {
            await deployWorkers({ api, bundle: previous, state, secrets: {}, log });
          } else if (phase === "switched") {
            throw new Error("the previous release's bundle is not available to redeploy");
          }
        }
        await api.d1Restore(state.accountId, databaseId, outcome.bookmark);
        outcome.status = "rolled_back";
        await input.onStep?.("restored", outcome);
      } catch (rollbackError) {
        outcome.rollbackError = (rollbackError as Error).message;
        log(`rollback failed: ${outcome.rollbackError}`);
      }
    }
  } finally {
    try {
      await step("resume");
      await automations.resume();
    } catch (error) {
      log(`could not resume automations: ${(error as Error).message}`);
    }
  }
  await input.onStep?.("done", outcome);
  return outcome;
}

/** Admin rollback: redeploy the previous release and restore the bookmark taken before the update. */
export async function runRollback(input: {
  api: CloudflareClient;
  state: DeploymentState;
  databaseId: string;
  previous: ReleaseBundle;
  previousDigest?: string;
  bookmark: string | null;
  automations?: AutomationControl;
  log?: Log;
}): Promise<{ version: string; restoredBookmark: string | null }> {
  const automations = input.automations ?? noAutomationControl;
  const log = input.log ?? (() => {});
  await automations.pause();
  try {
    log(`redeploying ${input.previous.manifest.version}…`);
    await deployWorkers({
      api: input.api,
      bundle: input.previous,
      state: input.state,
      secrets: {},
      log,
    });
    if (input.bookmark) {
      log("restoring the database bookmark…");
      await input.api.d1Restore(input.state.accountId, input.databaseId, input.bookmark);
    }
    await writeDeploymentState(input.api, input.databaseId, {
      ...input.state,
      version: input.previous.manifest.version,
      ...(input.previousDigest ? { bundleDigest: input.previousDigest } : {}),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await automations.resume();
  }
  return { version: input.previous.manifest.version, restoredBookmark: input.bookmark };
}

/** Default smoke check: /api/health answers ok, at the expected version, schema up to date. */
export async function healthSmoke(
  hostname: string,
  version: string,
  options: { fetch?: typeof fetch; attempts?: number; delayMs?: number; origin?: string } = {},
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const attempts = options.attempts ?? 20;
  let last = "no response";
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await doFetch(`${options.origin ?? `https://${hostname}`}/api/health`, {
        headers: { "cache-control": "no-cache" },
      });
      const body = (await response.json()) as {
        status?: string;
        version?: string;
        migrations?: { upToDate?: boolean };
      };
      if (
        response.ok &&
        body.status === "ok" &&
        body.version === version &&
        body.migrations?.upToDate !== false
      ) {
        return;
      }
      last = `status ${body.status}, version ${body.version}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (options.delayMs !== 0) await new Promise((r) => setTimeout(r, options.delayMs ?? 3000));
  }
  throw new Error(`smoke check failed for ${hostname}: ${last}`);
}
