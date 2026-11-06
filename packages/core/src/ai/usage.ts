// Model usage counted in the workspace (migration 0260, ADR 0213 amendment). A hosted deployment
// calls the customer's own keys directly at the provider, so no gateway we can read sees those
// calls: the model client reports every call's tokens (ModelRunnerOptions.recordUsage) and this
// adds them up per day, role and provider. Settings → AI shows it; nothing here is billed. Only
// counts are kept, never a prompt, a reply or a key.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { loadEntitlements } from "../entitlements.ts";
import type { AiEnv, ModelRunnerOptions, ModelUsage } from "./client.ts";
import { isHosted } from "./platform.ts";
import { type ModelRole, normalizeRole, PROVIDER_INFO, type ProviderId } from "./roles.ts";

/**
 * The model runner options a hosted deployment adds (ros-app and ros-runner alike): the plan for
 * the tenant tag, from the entitlement row, and usage counting. Nothing on a self-hosted install.
 * `schedule` keeps the usage write alive after the response (the Worker's waitUntil).
 */
export function hostedModelOptions(
  env: AiEnv,
  db: Kysely<CoreDatabase>,
  schedule: (work: Promise<unknown>) => void = () => {},
): Pick<ModelRunnerOptions, "plan" | "recordUsage"> {
  if (!isHosted(env)) return {};
  return {
    plan: async () => (await loadEntitlements(db))?.plan ?? null,
    recordUsage: (usage) => {
      schedule(
        recordAiUsage(db, usage).catch((error: unknown) =>
          console.error("AI usage could not be recorded", error),
        ),
      );
    },
  };
}

/** Adds one call to today's row for its role and provider. */
export async function recordAiUsage(
  db: Kysely<CoreDatabase>,
  usage: ModelUsage,
  now: Date = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const tokensIn = Math.max(0, Math.round(usage.tokensIn) || 0);
  const tokensOut = Math.max(0, Math.round(usage.tokensOut) || 0);
  await db
    .insertInto("core_ai_usage")
    .values({
      day,
      role: usage.role,
      provider: usage.provider,
      billed: usage.billed ? 1 : 0,
      requests: 1,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    })
    .onConflict((oc) =>
      oc.columns(["day", "role", "provider"]).doUpdateSet((eb) => ({
        requests: eb("core_ai_usage.requests", "+", 1),
        tokens_in: eb("core_ai_usage.tokens_in", "+", tokensIn),
        tokens_out: eb("core_ai_usage.tokens_out", "+", tokensOut),
        billed: usage.billed ? 1 : 0,
      })),
    )
    .execute();
}

export interface ProviderUsage {
  provider: ProviderId | string;
  label: string;
  /** Platform AI (billed to the plan) or the customer's own key (never billed). */
  billed: boolean;
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

/** Usage over the last `days` days (today included), per role and per provider. */
export async function workspaceUsage(
  db: Kysely<CoreDatabase>,
  days: number,
  now: Date = new Date(),
): Promise<{
  roles: { role: ModelRole | "other"; requests: number; tokensIn: number; tokensOut: number }[];
  providers: ProviderUsage[];
}> {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.selectFrom("core_ai_usage").selectAll().where("day", ">=", since).execute();
  const roles = new Map<string, { requests: number; tokensIn: number; tokensOut: number }>();
  const providers = new Map<string, ProviderUsage>();
  for (const row of rows) {
    // Rows from before ADR 0351 carry the old `assistant` role.
    const role = normalizeRole(row.role) ?? "other";
    const r = roles.get(role) ?? { requests: 0, tokensIn: 0, tokensOut: 0 };
    r.requests += row.requests;
    r.tokensIn += row.tokens_in;
    r.tokensOut += row.tokens_out;
    roles.set(role, r);
    const key = `${row.provider}:${row.billed}`;
    const label = PROVIDER_INFO[row.provider as ProviderId]?.label ?? row.provider;
    const p = providers.get(key) ?? {
      provider: row.provider,
      label,
      billed: row.billed === 1,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    p.requests += row.requests;
    p.tokensIn += row.tokens_in;
    p.tokensOut += row.tokens_out;
    providers.set(key, p);
  }
  return {
    roles: [...roles.entries()]
      .map(([role, t]) => ({ role: role as ModelRole | "other", ...t }))
      .sort((a, b) => b.requests - a.requests),
    providers: [...providers.values()].sort((a, b) => b.requests - a.requests),
  };
}
