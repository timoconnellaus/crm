// AI usage billing (ADR 0213 and its amendment). Every hosted deployment's Platform AI goes
// through one shared AI Gateway, each call tagged with the tenant (`cf-aig-metadata`), and AI
// Gateway logs it with its provider and cost estimate. Once a day, per deployment, metering reads
// that gateway's logs filtered by the tenant tag (and, for a deployment provisioned before the
// shared gateway, its own gateway's logs):
//
//   provider cost   all logged spend (shown to the customer, itemised)
//   billable cost   spend on providers we pay for (PLATFORM_AI_PROVIDERS, default Workers AI),
//                   excluding cache hits. The customer's own keys are called directly at the
//                   provider (or through their own gateway) and never reach ours: free here, and
//                   shown to them in the workspace. Calls an MCP client makes with its own model
//                   never reach a gateway at all.
//   charged         billable × (1 + AI_MARKUP_PERCENT/100), in dollars, never "credits"
//
// Paid plans: charged spend beyond the plan's monthly allowance is reported to Stripe as a Billing
// Meter event in cents (identifier `ai-<tenant>-<day>`, so a retried day is never double-billed).
// Free plan: charged spend is debited from prepaid credit; when it runs out the entitlement
// `platformAi` turns off and platform-paid models stop (BYOK and MCP keep working).
import { CloudflareApiError, type DeploymentState } from "@relationship-os/release";
import { audit } from "./audit.ts";
import {
  type AccountRow,
  accountById,
  type InstanceRow,
  instanceById,
  instanceState,
} from "./db.ts";
import { intVar } from "./env.ts";
import { syncEntitlements } from "./instances.ts";
import { chargedMicros, overageCents, PLANS } from "./plans.ts";
import { platformGatewayId } from "./platform-ai.ts";
import type { Services } from "./services.ts";
import { dollars } from "./util.ts";

/** At most this many log pages (50 each) are read per deployment per day. */
const MAX_PAGES = 400;

export interface DayUsage {
  requests: number;
  providerCostMicros: number;
  billableCostMicros: number;
  unpriced: number;
  truncated: boolean;
}

/**
 * A deployment's own gateway, if it has one: only a deployment provisioned before the shared
 * Platform AI gateway (ADR 0180); new hosted deployments have `aiGateway: false`.
 */
function ownGatewayOf(state: DeploymentState): string | null {
  if (state.ai === false) return null;
  return typeof state.aiGateway === "string" && state.aiGateway ? state.aiGateway : null;
}

/** The tenant a shared-gateway log is tagged with (its `cf-aig-metadata`), or null. */
function taggedTenant(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const tenant = (JSON.parse(metadata) as { tenant?: unknown }).tenant;
    return typeof tenant === "string" ? tenant : null;
  } catch {
    return null;
  }
}

const EMPTY: DayUsage = {
  requests: 0,
  providerCostMicros: 0,
  billableCostMicros: 0,
  unpriced: 0,
  truncated: false,
};

function addUsage(a: DayUsage, b: DayUsage): DayUsage {
  return {
    requests: a.requests + b.requests,
    providerCostMicros: a.providerCostMicros + b.providerCostMicros,
    billableCostMicros: a.billableCostMicros + b.billableCostMicros,
    unpriced: a.unpriced + b.unpriced,
    truncated: a.truncated || b.truncated,
  };
}

/**
 * One day of a gateway's logs. With `tenant`, the shared platform gateway: only logs whose tenant
 * tag is that tenant (the API filters by metadata value; each log is checked again here, so a log
 * whose tag merely contains the same value under another key is never billed to it).
 */
export async function readDayUsage(
  s: Services,
  gatewayId: string,
  day: string,
  tenant?: string,
): Promise<DayUsage> {
  const platform = new Set(
    (s.env.PLATFORM_AI_PROVIDERS ?? "workers-ai")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  const from = `${day}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const usage: DayUsage = {
    requests: 0,
    providerCostMicros: 0,
    billableCostMicros: 0,
    unpriced: 0,
    truncated: false,
  };
  for (let page = 1; ; page++) {
    const { logs, totalPages } = await s.cf.gatewayLogs(s.accountId, gatewayId, {
      from,
      to,
      page,
      ...(tenant ? { metadataValue: tenant } : {}),
    });
    for (const log of logs) {
      if (tenant && taggedTenant(log.metadata) !== tenant) continue;
      usage.requests += 1;
      const micros = log.cost == null ? 0 : Math.round(log.cost * 1_000_000);
      usage.providerCostMicros += micros;
      if (!platform.has(log.provider) || log.cached) continue;
      if (log.cost == null) usage.unpriced += 1;
      usage.billableCostMicros += micros;
    }
    if (page >= totalPages || logs.length === 0) break;
    if (page >= MAX_PAGES) {
      usage.truncated = true;
      break;
    }
  }
  return usage;
}

/** Meters one deployment's AI usage for one UTC day. Idempotent per (instance, day). */
export async function meterDay(s: Services, instanceId: string, day: string): Promise<void> {
  const done = await s.db
    .prepare("SELECT 1 FROM cp_ai_usage WHERE instance_id = ? AND day = ?")
    .bind(instanceId, day)
    .first();
  if (done) return;
  const instance = await instanceById(s.db, instanceId);
  const state = instance ? instanceState(instance) : null;
  if (!instance || !state || instance.placement === "customer-account") return;
  const account = await accountById(s.db, instance.account_id);
  if (!account) return;
  let usage: DayUsage = EMPTY;
  if (state.ai !== false) {
    usage = await readDayUsage(s, platformGatewayId(s), day, instanceId).catch((error) => {
      // The shared gateway not existing yet means no Platform AI call has been made.
      if (error instanceof CloudflareApiError && error.status === 404) return EMPTY;
      throw error;
    });
  }
  const own = ownGatewayOf(state);
  if (own) usage = addUsage(usage, await readDayUsage(s, own, day));
  const markup = intVar(s.env.AI_MARKUP_PERCENT, 20);
  const charged = chargedMicros(usage.billableCostMicros, markup);
  const month = day.slice(0, 7);
  const plan = PLANS[account.plan];
  let overage = 0;
  let identifier: string | null = null;
  let debit = 0;

  if (plan.paid && charged > 0) {
    const totals = await s.db
      .prepare(
        "SELECT COALESCE(SUM(charged_micros), 0) AS charged, COALESCE(SUM(overage_cents), 0) AS reported FROM cp_ai_usage WHERE instance_id = ? AND month = ?",
      )
      .bind(instanceId, month)
      .first<{ charged: number; reported: number }>();
    overage = overageCents({
      allowanceMicros: plan.aiIncludedMicros,
      monthChargedAfterMicros: (totals?.charged ?? 0) + charged,
      reportedCents: totals?.reported ?? 0,
    });
    if (overage > 0 && account.stripe_customer_id) {
      identifier = `ai-${instanceId}-${day}`;
      await s.stripe.meterEvent({
        eventName: s.env.STRIPE_METER_EVENT || "ai_overage_cents",
        customer: account.stripe_customer_id,
        value: overage,
        identifier,
        // Midday of the metered day: within Stripe's 35-day window and in the right period.
        timestamp: Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000),
      });
    }
  } else if (!plan.paid && charged > 0) {
    debit = charged;
  }

  const statements = [
    s.db
      .prepare(
        "INSERT INTO cp_ai_usage (instance_id, day, month, requests, provider_cost_micros, billable_cost_micros, charged_micros, overage_cents, credit_debit_micros, unpriced, truncated, meter_identifier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (instance_id, day) DO NOTHING",
      )
      .bind(
        instanceId,
        day,
        month,
        usage.requests,
        usage.providerCostMicros,
        usage.billableCostMicros,
        charged,
        overage,
        debit,
        usage.unpriced,
        usage.truncated ? 1 : 0,
        identifier,
        s.now().toISOString(),
      ),
  ];
  if (debit > 0) {
    statements.push(
      s.db
        .prepare("UPDATE cp_accounts SET ai_credit_micros = ai_credit_micros - ? WHERE id = ?")
        .bind(debit, account.id),
    );
  }
  await s.db.batch(statements);

  if (debit > 0) {
    const after = (await accountById(s.db, account.id)) as AccountRow;
    if (after.ai_credit_micros <= 0 && account.ai_credit_micros > 0) {
      await syncEntitlements(s, after, instance as InstanceRow);
      await audit(
        s.db,
        {
          actorKind: "system",
          actor: "metering",
          action: "billing.credit_exhausted",
          accountId: account.id,
          instanceId,
          detail: { balance: dollars(after.ai_credit_micros) },
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
          subject: "Your Relationship OS AI credit has run out",
          text: `Built-in AI is paused until you add credit at ${s.origin}/account. Your own provider keys (BYOK) and AI clients connected over MCP keep working.`,
        });
      }
    }
  }
}

export interface MonthUsage {
  month: string;
  requests: number;
  providerCostMicros: number;
  chargedMicros: number;
  includedMicros: number;
  overageCents: number;
  creditDebitMicros: number;
}

export async function monthUsage(s: Services, instanceId: string, account: AccountRow) {
  const month = s.now().toISOString().slice(0, 7);
  const row = await s.db
    .prepare(
      "SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(provider_cost_micros), 0) AS provider, COALESCE(SUM(charged_micros), 0) AS charged, COALESCE(SUM(overage_cents), 0) AS overage, COALESCE(SUM(credit_debit_micros), 0) AS debit FROM cp_ai_usage WHERE instance_id = ? AND month = ?",
    )
    .bind(instanceId, month)
    .first<{
      requests: number;
      provider: number;
      charged: number;
      overage: number;
      debit: number;
    }>();
  return {
    month,
    requests: row?.requests ?? 0,
    providerCostMicros: row?.provider ?? 0,
    chargedMicros: row?.charged ?? 0,
    includedMicros: PLANS[account.plan].aiIncludedMicros,
    overageCents: row?.overage ?? 0,
    creditDebitMicros: row?.debit ?? 0,
  } satisfies MonthUsage;
}
