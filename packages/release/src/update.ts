// The upgrade and rollback procedures (ADR 0054, ADR 0164), shared by the self-updater and
// `ros upgrade` so both do exactly the same thing:
//
//   1. pause automations          (AutomationControl: the automations kill switch)
//   2. take a D1 Time Travel bookmark
//   3. apply core migrations
//   4. create resources the new release adds (and the AI Gateway, ADR 0180), then switch all
//      Workers together
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
  neededResources,
  provisionResources,
  writeDeploymentState,
} from "./deploy.ts";
import {
  GATEWAY_TOKEN_SECRET,
  mergeSecrets,
  provisionAiGateway,
  retireGatewayToken,
} from "./gateway.ts";
import { adoptLegacyNames } from "./legacy.ts";

/** Pauses and resumes automations around an update. */
export interface AutomationControl {
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export const noAutomationControl: AutomationControl = {
  async pause() {},
  async resume() {},
};

/** Stage 5's admin kill switch (core_settings, JSON boolean, migration 0130). */
export const KILL_SWITCH_SETTING = "automations_kill_switch";

/** Where the kill switch is read and written: D1 directly (the app) or over the REST API (CLI). */
export interface KillSwitchStore {
  /** The current value; false when unset. */
  read(): Promise<boolean>;
  write(on: boolean): Promise<void>;
}

/**
 * Pauses automations with Stage 5's kill switch, reversibly: pause turns it on and remembers
 * whether it was already on; resume turns it off only if pause turned it on. So a switch an
 * admin had flipped before the update stays on afterwards. Resume runs after the smoke check,
 * and after a rollback too (a Time Travel restore brings back the "on" taken after pause, which
 * resume then turns off).
 */
export function killSwitchControl(store: KillSwitchStore): AutomationControl {
  let turnedOn = false;
  return {
    async pause() {
      if (await store.read()) return;
      await store.write(true);
      turnedOn = true;
    },
    async resume() {
      if (!turnedOn) return;
      await store.write(false);
      turnedOn = false;
    },
  };
}

/** The kill switch over the D1 REST API, for `ros upgrade` and `ros rollback`. */
export function apiKillSwitchStore(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): KillSwitchStore {
  return {
    async read() {
      try {
        const [first] = await api.queryD1<{ value: string }>(
          accountId,
          databaseId,
          "SELECT value FROM core_settings WHERE key = ?",
          [KILL_SWITCH_SETTING],
        );
        const row = first?.results[0];
        return row ? JSON.parse(row.value) === true : false;
      } catch {
        // No core_settings yet (a database older than any automation): nothing runs to pause.
        return true;
      }
    },
    async write(on) {
      const now = new Date().toISOString();
      await api.queryD1(
        accountId,
        databaseId,
        "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [KILL_SWITCH_SETTING, JSON.stringify(on), now],
      );
    },
  };
}

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

/** An AI_GATEWAY_TOKEN the caller sets in this deploy, if any (then none is generated). */
function suppliedGatewayToken(secrets: UpdateInput["secrets"]): { token?: string } {
  for (const values of Object.values(secrets ?? {})) {
    const token = values[GATEWAY_TOKEN_SECRET];
    if (token) return { token };
  }
  return {};
}

export async function runUpdate(input: UpdateInput): Promise<UpdateOutcome> {
  const log = input.log ?? (() => {});
  const automations = input.automations ?? noAutomationControl;
  const { api, databaseId, target } = input;
  // An install from before the rename keeps its deployed names (ADR 0190).
  const state = adoptLegacyNames(input.state, target.manifest);
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
    // Resources the new release adds (a queue, an index) are created before its Workers bind
    // them; existing ones are found by name.
    const resources = {
      ...state.resources,
      ...(await provisionResources(
        api,
        state.accountId,
        neededResources(target.manifest, state.gatekeepers, state).filter(
          (r) => r.placeholder && !(r.placeholder.slice(1) in state.resources),
        ),
        log,
        state.resourceNames,
      )),
    };
    // AI Gateway (with AI on): created or checked, so an upgrade adds what an install would.
    const gateway = await provisionAiGateway({
      api,
      manifest: target.manifest,
      state: { ...state, resources },
      ...suppliedGatewayToken(input.secrets),
      log,
    });
    const switched: DeploymentState = {
      ...state,
      resources,
      vars: gateway.vars,
      ...gateway.state,
    };
    await deployWorkers({
      api,
      bundle: target,
      state: switched,
      secrets: mergeSecrets(input.secrets ?? {}, gateway.secrets),
      log,
    });
    phase = "switched";

    await step("smoke");
    await input.smoke(state.hostname, target.manifest.version);

    const next: DeploymentState = {
      ...switched,
      version: target.manifest.version,
      ...(input.targetDigest ? { bundleDigest: input.targetDigest } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeDeploymentState(api, databaseId, next);
    outcome.status = "succeeded";
    // A gateway token this update replaced (ADR 0330) is deleted only now that the new one is live.
    await retireGatewayToken(api, state.accountId, gateway.retiredTokenId, log);
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
