// Customer deployments (ADR 0210): provisioning with the Stage 8 deploy engine, the entitlement
// row, and the lifecycle states the dispatch Worker enforces.
//
//   placement "namespace"  user Workers in the dispatch namespace (SaaS, enterprise dedicated)
//   placement "account"    ordinary Workers in our account on a Custom Domain (the fallback if a
//                          Workers for Platforms gap blocks the namespace; same engine, Stage 8 as is)
//   placement "customer-account"  managed enterprise in the customer's own account: operated by
//                          runbook with `create-relationship-os`, recorded here, never provisioned here
//
// Resources are per tenant (`ros-<tenant>`, `ros-files-<tenant>`…): no D1 is shared, and no tenant
// id exists in a deployment's data (ADR 0001). The one shared thing is the Platform AI gateway
// (ADR 0213 amendment): a hosted deployment gets no gateway or gateway token of its own, only the
// shared gateway's id, its tenant id (a var, for the tenant tag) and the platform token.
import {
  CloudflareApiError,
  type DeploymentState,
  gatewayWorkers,
  installRelease,
  mergeSecrets,
  type ReleaseManifest,
  scriptsApi,
  selectedWorkers,
} from "@relationship-os/release";
import { audit } from "./audit.ts";
import {
  type AccountRow,
  accountById,
  type InstanceRow,
  instanceById,
  instanceState,
  instancesWithStatus,
  updateInstance,
} from "./db.ts";
import { intVar } from "./env.ts";
import { type Entitlements, entitlementsFor } from "./plans.ts";
import {
  aiWorkers,
  ensurePlatformGateway,
  platformAiSecrets,
  platformAiVars,
} from "./platform-ai.ts";
import {
  deleteRoute,
  type RouteStatus,
  type ScheduleEntry,
  writeRoute,
  writeSchedule,
} from "./routing.ts";
import type { Services } from "./services.ts";
import { randomToken } from "./util.ts";

export const tenantTag = (tenantId: string) => `tenant-${tenantId}`;

/** Deployed names for one tenant: every Worker and resource of the manifest, suffixed. */
export function tenantNames(manifest: ReleaseManifest, tenantId: string) {
  const workerNames: Record<string, string> = {};
  for (const w of manifest.workers) workerNames[w.name] = `${tenantId}-${w.name}`;
  const resourceNames: Record<string, string> = {};
  for (const r of manifest.resources) resourceNames[r.name] = `${r.name}-${tenantId}`;
  return { workerNames, resourceNames };
}

export function initialState(input: {
  instance: InstanceRow;
  manifest: ReleaseManifest;
  accountId: string;
  supportPublicKey: string;
  zoneId?: string | undefined;
  /** Platform AI's vars per manifest Worker (platformAiVars). */
  platformVars?: DeploymentState["vars"];
  now: Date;
}): DeploymentState {
  const { instance, manifest } = input;
  const { workerNames, resourceNames } = tenantNames(manifest, instance.id);
  const app = manifest.workers.find((w) => w.role === "app")?.name ?? "ros-app";
  const namespaced = instance.placement === "namespace";
  const vars: DeploymentState["vars"] = { ...input.platformVars };
  if (input.supportPublicKey) {
    vars[app] = { ...vars[app], ROS_SUPPORT_PUBLIC_KEY: input.supportPublicKey };
  }
  return {
    version: manifest.version,
    accountId: input.accountId,
    hostname: instance.custom_hostname ?? instance.hostname,
    hostnameMode: namespaced ? "dispatch" : "custom",
    ...(namespaced ? { dispatchNamespace: instance.namespace ?? undefined } : {}),
    ...(!namespaced && input.zoneId ? { zoneId: input.zoneId } : {}),
    tags: [tenantTag(instance.id)],
    identityProvider: "better-auth",
    channel: manifest.channel,
    gatekeepers: [],
    ai: true,
    // No AI Gateway or gateway token per hosted deployment: Platform AI goes through the shared
    // gateway, the customer's own keys go to the provider directly (ADR 0210 amendment).
    aiGateway: false,
    workerNames,
    resourceNames,
    vars,
    resources: {},
    installedAt: input.now.toISOString(),
  };
}

/** Script name → crons, for the dispatch Worker's schedule. */
export function cronsOf(manifest: ReleaseManifest, state: DeploymentState) {
  const out: Record<string, string[]> = {};
  for (const w of selectedWorkers(manifest, state)) {
    if (w.crons.length) out[state.workerNames[w.name] ?? w.name] = w.crons;
  }
  return out;
}

async function ensureNamespace(s: Services, namespace: string) {
  if (!(await s.cf.getDispatchNamespace(s.accountId, namespace))) {
    await s.cf.createDispatchNamespace(s.accountId, namespace);
  }
}

export async function provisionInstance(s: Services, instanceId: string): Promise<void> {
  const instance = await instanceById(s.db, instanceId);
  if (!instance) throw new Error(`no instance ${instanceId}`);
  if (instance.status !== "pending" && instance.status !== "failed") return;
  if (instance.placement === "customer-account") {
    throw new Error("managed deployments in a customer's account are installed by runbook");
  }
  const account = await accountById(s.db, instance.account_id);
  if (!account) throw new Error(`no account ${instance.account_id}`);
  const now = s.now();
  await updateInstance(s.db, instanceId, { status: "provisioning", error: null }, now);
  try {
    const version =
      instance.version ??
      (await s.releases.latest(s.env.RELEASE_CHANNEL === "beta" ? "beta" : "stable"));
    const release = await s.releases.load(version);
    if (instance.placement === "namespace" && instance.namespace) {
      await ensureNamespace(s, instance.namespace);
    }
    // The shared Platform AI gateway: created once, its safety settings checked every time.
    await ensurePlatformGateway(s);
    const manifest = release.bundle.manifest;
    const app = manifest.workers.find((w) => w.role === "app")?.name ?? "ros-app";
    const ai = { tenant: instance.id, workers: aiWorkers(gatewayWorkers(manifest)), app };
    const base = initialState({
      instance,
      manifest,
      accountId: s.accountId,
      supportPublicKey: s.env.SUPPORT_PUBLIC_KEY ?? "",
      zoneId: s.env.SAAS_ZONE_ID,
      platformVars: platformAiVars(s, ai),
      now,
    });
    const result = await installRelease({
      api: s.cf,
      bundle: release.bundle,
      state: { ...base, bundleDigest: release.digest },
      secrets: mergeSecrets(
        {
          [app]: {
            BETTER_AUTH_SECRET: randomToken() + randomToken(),
            BETTER_AUTH_URL: `https://${base.hostname}`,
          },
        },
        await platformAiSecrets(s, ai),
      ),
    });
    await writeEntitlements(s, result.databaseId, entitlementsFor(account.plan, account, now));
    const crons = cronsOf(release.bundle.manifest, result.state);
    await updateInstance(
      s.db,
      instanceId,
      {
        status: "active",
        version: release.version,
        state: JSON.stringify(result.state),
        database_id: result.databaseId,
        crons: JSON.stringify(crons),
        last_activity_at: now.toISOString(),
      },
      s.now(),
    );
    const active = await instanceById(s.db, instanceId);
    if (active) await publishRoute(s, active, "active");
    await audit(
      s.db,
      {
        actorKind: "system",
        actor: "provisioner",
        action: "instance.provisioned",
        accountId: account.id,
        instanceId,
        detail: { version: release.version, hostname: base.hostname, warnings: result.warnings },
      },
      s.now(),
    );
    const owner = await s.db
      .prepare("SELECT email FROM cp_users WHERE id = ?")
      .bind(account.owner_user_id)
      .first<{ email: string }>();
    if (owner) {
      await s.mail.send({
        to: owner.email,
        subject: "Your Relationship OS workspace is ready",
        text: `Your workspace is ready at https://${base.hostname}\n\nOpen https://${base.hostname}/setup to create your sign-in and finish setting up.`,
      });
    }
  } catch (error) {
    await updateInstance(
      s.db,
      instanceId,
      { status: "failed", error: (error as Error).message.slice(0, 500) },
      s.now(),
    );
    await audit(
      s.db,
      {
        actorKind: "system",
        actor: "provisioner",
        action: "instance.provision_failed",
        accountId: instance.account_id,
        instanceId,
        detail: { error: (error as Error).message },
      },
      s.now(),
    );
    throw error;
  }
}

// ---- Entitlements -------------------------------------------------------------------------------

/** Writes the entitlement row into the customer's D1 (`core_entitlements`, migration 0220). */
export async function writeEntitlements(s: Services, databaseId: string, value: Entitlements) {
  await s.cf.queryD1(
    s.accountId,
    databaseId,
    "INSERT INTO core_entitlements (key, value, updated_at) VALUES ('plan', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [JSON.stringify(value), value.updatedAt],
  );
}

/** Re-applies an account's plan to its deployment (after a plan, billing or credit change). */
export async function syncEntitlements(s: Services, account: AccountRow, instance: InstanceRow) {
  if (!instance.database_id || instance.placement === "customer-account") return;
  if (!["active", "paused", "suspended"].includes(instance.status)) return;
  await writeEntitlements(s, instance.database_id, entitlementsFor(account.plan, account, s.now()));
}

// ---- Routing and lifecycle ----------------------------------------------------------------------

export async function publishRoute(s: Services, instance: InstanceRow, status: RouteStatus) {
  const state = instanceState(instance);
  if (instance.placement === "namespace" && state) {
    const app = Object.entries(state.workerNames).find(([name]) => name.endsWith("-app"));
    const script = app?.[1] ?? `${instance.id}-ros-app`;
    for (const host of [instance.hostname, instance.custom_hostname]) {
      // A custom hostname is routed only once Cloudflare for SaaS has verified it.
      if (
        !host ||
        (host === instance.custom_hostname && instance.custom_hostname_status !== "active")
      ) {
        continue;
      }
      await writeRoute(s.routes, host, { tenant: instance.id, script, status });
    }
  }
  await rebuildSchedule(s);
}

/**
 * The schedule the dispatch Worker runs: crons of every active namespaced tenant. Paused and
 * suspended tenants are left out, so they cost no invocations.
 */
export async function rebuildSchedule(s: Services) {
  const active = await instancesWithStatus(s.db, ["active"]);
  const entries: ScheduleEntry[] = active
    .filter((i) => i.placement === "namespace" && i.crons)
    .map((i) => ({ tenant: i.id, scripts: JSON.parse(i.crons as string) }));
  await writeSchedule(s.routes, entries);
}

/** Crons for an "account"-placed deployment are ordinary Cron Triggers: on or off. */
async function setAccountCrons(s: Services, instance: InstanceRow, on: boolean) {
  if (instance.placement !== "account" || !instance.crons) return;
  const crons = JSON.parse(instance.crons) as Record<string, string[]>;
  for (const [script, list] of Object.entries(crons)) {
    await s.cf.putSchedules(s.accountId, script, on ? list : []);
  }
}

export type LifecycleChange = "pause" | "wake" | "suspend" | "resume";

/**
 * Moves an instance between active, paused and suspended. Pausing (idle Free tenants) and
 * suspending (billing) both stop its crons; suspending also stops its traffic.
 */
export async function changeLifecycle(
  s: Services,
  instanceId: string,
  change: LifecycleChange,
  actor: { kind: "system" | "staff" | "customer" | "stripe"; id: string },
  reason?: string,
): Promise<boolean> {
  const instance = await instanceById(s.db, instanceId);
  if (!instance) return false;
  const from = instance.status;
  const allowed: Record<LifecycleChange, string[]> = {
    pause: ["active"],
    wake: ["paused"],
    suspend: ["active", "paused"],
    resume: ["suspended"],
  };
  if (!allowed[change].includes(from)) return false;
  const now = s.now();
  const to = change === "pause" ? "paused" : change === "suspend" ? "suspended" : "active";
  await updateInstance(
    s.db,
    instanceId,
    {
      status: to,
      paused_at: to === "paused" ? now.toISOString() : null,
      suspended_reason: to === "suspended" ? (reason ?? "billing") : null,
      ...(change === "wake" ? { last_activity_at: now.toISOString() } : {}),
    },
    now,
  );
  const updated = (await instanceById(s.db, instanceId)) as InstanceRow;
  await publishRoute(s, updated, to === "active" ? "active" : (to as RouteStatus));
  await setAccountCrons(s, updated, to === "active");
  await audit(
    s.db,
    {
      actorKind: actor.kind,
      actor: actor.id,
      action: `instance.${change}`,
      accountId: instance.account_id,
      instanceId,
      detail: { from, to, ...(reason ? { reason } : {}) },
    },
    now,
  );
  return true;
}

/** When a Free instance was last used: its newest sign-in session, read from its D1. */
export async function lastActivity(s: Services, instance: InstanceRow): Promise<string | null> {
  if (!instance.database_id) return null;
  try {
    const [first] = await s.cf.queryD1<{ at: string | null }>(
      s.accountId,
      instance.database_id,
      "SELECT MAX(updated_at) AS at FROM core_session",
    );
    return first?.results[0]?.at ?? null;
  } catch (error) {
    if (error instanceof CloudflareApiError && /no such table/i.test(error.message)) return null;
    throw error;
  }
}

/** Idle Free deployments are paused after IDLE_PAUSE_DAYS without a sign-in. */
export async function pauseIdle(s: Services): Promise<string[]> {
  const days = intVar(s.env.IDLE_PAUSE_DAYS, 60);
  const cutoff = new Date(s.now().getTime() - days * 86_400_000).toISOString();
  const paused: string[] = [];
  for (const instance of await instancesWithStatus(s.db, ["active"])) {
    const account = await accountById(s.db, instance.account_id);
    if (account?.plan !== "free") continue;
    const seen =
      (await lastActivity(s, instance)) ?? instance.last_activity_at ?? instance.created_at;
    const latest = [seen, instance.last_activity_at ?? ""].sort().pop() as string;
    if (latest !== instance.last_activity_at) {
      await updateInstance(s.db, instance.id, { last_activity_at: latest }, s.now());
    }
    if (latest < cutoff) {
      await changeLifecycle(s, instance.id, "pause", { kind: "system", id: "idle-sweep" }, "idle");
      paused.push(instance.id);
    }
  }
  return paused;
}

// ---- Deletion -----------------------------------------------------------------------------------

/**
 * Deletes everything a deployment had: its Workers (by tenant tag in the namespace), D1, R2, KV,
 * queues, Vectorize, and its routes; and, for a deployment provisioned before the shared Platform
 * AI gateway, its own AI Gateway and gateway token. The shared gateway is never deleted (its logs
 * for a deleted tenant age out). Each step tolerates "already gone", so a retry finishes a partial
 * deletion.
 */
export async function destroyInstance(s: Services, instance: InstanceRow): Promise<void> {
  const state = instanceState(instance);
  await updateInstance(s.db, instance.id, { status: "deleting" }, s.now());
  for (const host of [instance.hostname, instance.custom_hostname]) {
    if (host) await deleteRoute(s.routes, host);
  }
  await rebuildSchedule(s);
  const gone = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return;
      throw error;
    }
  };
  if (state) {
    const scripts = scriptsApi(s.cf, state);
    if (state.dispatchNamespace) {
      await gone(() => scripts.deleteScriptsByTag(s.accountId, tenantTag(instance.id)));
    } else {
      for (const name of Object.values(state.workerNames)) {
        await gone(() => s.cf.deleteScript(s.accountId, name));
      }
    }
    for (const [key, value] of Object.entries(state.resources)) {
      if (key.startsWith("D1_ID(")) await gone(() => s.cf.deleteD1(s.accountId, value));
      else if (key.startsWith("R2_NAME(")) await gone(() => s.cf.deleteR2(s.accountId, value));
      else if (key.startsWith("KV_ID(")) await gone(() => s.cf.deleteKv(s.accountId, value));
      else if (key.startsWith("VECTORIZE_NAME(")) {
        await gone(() => s.cf.deleteVectorize(s.accountId, value));
      }
    }
    const queues = await s.cf.listQueues(s.accountId);
    const mine = new Set(Object.values(state.resourceNames ?? {}));
    for (const q of queues.filter((q) => mine.has(q.queue_name))) {
      await gone(() => s.cf.deleteQueue(s.accountId, q.queue_id));
    }
    if (typeof state.aiGateway === "string" && state.aiGatewayCreated) {
      await gone(() => s.cf.deleteAiGateway(s.accountId, state.aiGateway as string));
    }
    if (state.aiGatewayTokenId) {
      await gone(() => s.cf.deleteAccountToken(s.accountId, state.aiGatewayTokenId as string));
    }
  }
  await updateInstance(
    s.db,
    instance.id,
    { status: "deleted", state: null, database_id: null, crons: null },
    s.now(),
  );
}
