// Notification delivery in ros-runner (stage 6b, ADR 0172): the minute cron's delivery tick and
// the channel routes the automation consumer fires. Both send through the integration host as a
// system caller (actor `automation`, origin `system` / `notifications`) acting for the org
// connection's owner, so every send is an outbound action the approval gate decides (ADR 0111):
// auto-applied when an admin enabled the internal kind, otherwise waiting in the approvals inbox.
import {
  type AutomationQueueMessage,
  type CallIntegration,
  type DeliveryReport,
  type DeliveryResult,
  type DigestComposer,
  deliverRouteMatches,
  type IntegrationCaller,
  loadDeliverySettings,
  loadRoutes,
  matchNotificationRoutes,
  type NotificationRoute,
  ROLES,
  type Role,
  resolveChannelTarget,
  runNotificationDelivery,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { integrationRuntime } from "../integrations/runtime.ts";

/** What delivery needs from the runner's env. */
export type NotificationEnv = Pick<Env, "DB" | "INTEGRATION_HOST"> & { APP_ORIGIN?: string };

/** Origin of every notification send (its pending actions group in one change set per owner). */
export const NOTIFICATION_ORIGIN = {
  surface: "system",
  automationId: "system.notifications",
  sessionId: "notifications",
} as const;

export function appOrigin(env: { APP_ORIGIN?: string }): string | null {
  const origin = env.APP_ORIGIN?.trim();
  return origin ? origin.replace(/\/+$/, "") : null;
}

/**
 * `integration.call` as the system on an org connection, acting for the connection's owner (the
 * admin who set it up). Owners are read once per connection per tick.
 */
export function systemCallIntegration(env: NotificationEnv): CallIntegration {
  const runtime = integrationRuntime(env as Env);
  const callers = new Map<string, Promise<IntegrationCaller>>();
  const callerFor = (connectionId: string) => {
    let caller = callers.get(connectionId);
    if (!caller) {
      caller = (async () => {
        const row = await env.DB.prepare(
          `SELECT u.id, u.name, u.role FROM core_integration_connection c
           JOIN core_user u ON u.id = c.owner_user_id WHERE c.id = ?`,
        )
          .bind(connectionId)
          .first<{ id: string; name: string; role: string }>();
        if (!row) throw new Error(`Connection ${connectionId} has no owner`);
        return {
          actor: "automation",
          userId: row.id,
          userName: row.name,
          role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
          origin: { ...NOTIFICATION_ORIGIN },
          reason: "Notification delivery (Settings → Notifications)",
        } satisfies IntegrationCaller;
      })();
      callers.set(connectionId, caller);
    }
    return caller;
  };
  return async (input) => {
    const result = await runtime.call({ ...input, caller: await callerFor(input.connectionId) });
    return { value: result.value, pending: result.pending, applied: result.applied };
  };
}

/** The minute cron's delivery tick. `callIntegration` and `composeDigest` are for tests. */
export async function runNotificationCron(
  env: NotificationEnv,
  at: Date = new Date(),
  options: { callIntegration?: CallIntegration; composeDigest?: DigestComposer } = {},
): Promise<DeliveryReport> {
  const report = await runNotificationDelivery({
    db: createCrmDb(env.DB).query,
    now: at,
    appOrigin: appOrigin(env),
    callIntegration: options.callIntegration ?? systemCallIntegration(env),
    ...(options.composeDigest ? { composeDigest: options.composeDigest } : {}),
  });
  for (const problem of report.problems) console.warn(`notification delivery: ${problem}`);
  return report;
}

/**
 * Channel routes for a batch of automation messages (called once per dispatch batch). Never
 * throws: a failed post is recorded in the ledger and the batch's runs go on.
 */
export async function deliverNotificationRoutes(
  env: { DB: D1Database } & Partial<Pick<Env, "INTEGRATION_HOST" | "APP_ORIGIN">>,
  messages: readonly AutomationQueueMessage[],
  options: { now?: Date; callIntegration?: CallIntegration } = {},
): Promise<DeliveryResult[]> {
  try {
    const records = messages.filter((m) => m.kind === "record");
    if (!records.length) return [];
    if (!env.INTEGRATION_HOST && !options.callIntegration) return [];
    const db = createCrmDb(env.DB).query;
    let routes: NotificationRoute[] | null = null;
    const matches = [];
    for (const message of records) {
      routes ??= (await loadRoutes(db)).filter((r) => r.enabled);
      if (!routes.length) return [];
      matches.push(...matchNotificationRoutes(message, routes));
    }
    if (!matches.length) return [];
    const settings = await loadDeliverySettings(db);
    if (!settings.slack) return [];
    const resolved = await resolveChannelTarget(db, "slack", settings.slack);
    if ("problem" in resolved) {
      console.warn(`notification routes: ${resolved.problem}`);
      return [];
    }
    return await deliverRouteMatches({
      db,
      matches,
      target: resolved.target,
      callIntegration: options.callIntegration ?? systemCallIntegration(env as NotificationEnv),
      appOrigin: appOrigin(env),
      now: (options.now ?? new Date()).toISOString(),
    });
  } catch (error) {
    console.error("notification routes failed", error);
    return [];
  }
}
