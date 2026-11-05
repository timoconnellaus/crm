// Plan entitlements (ADR 0211). The hosted control plane writes one row, key 'plan', into
// core_entitlements through the D1 REST API; nothing in the deployment writes it (no operation, no
// UI, no AI path). A self-hosted install has no row and no limits at all; a `null` limit is
// unlimited.
//
// Reads are cached per isolate for 60 s, so a hot path pays at most one PK read a minute. Under
// Workers for Platforms every customer is its own script, so an isolate only ever serves one
// deployment's D1 and one module-level cache is enough. Counts run only when a limit is set.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { PlanLimitError } from "./errors.ts";

export const PLANS = ["free", "team", "business", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

/** Where a customer upgrades (the control plane's billing page). */
export const BILLING_URL = "https://app.relationshiposcrm.com/billing";

export const ENTITLEMENTS_KEY = "plan";
export const ENTITLEMENTS_TTL_MS = 60_000;

export const entitlementsSchema = z.object({
  plan: z.enum(PLANS),
  maxUsers: z.number().int().min(0).nullable(),
  maxRecords: z.number().int().min(0).nullable(),
  platformAi: z.boolean(),
  updatedAt: z.string(),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

const PLAN_LABELS: Record<Plan, string> = {
  free: "Free",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

let cache: { value: Entitlements | null; at: number } | null = null;

/** Test hook (and after a known change): forget the cached entitlements. */
export function clearEntitlementsCache(): void {
  cache = null;
}

/**
 * Parses the stored JSON. Unparseable or invalid → null ("no row"), logged. Why fail open: the
 * row is written only by our control plane, so a bad value is our bug, and locking a paying
 * customer out of their own CRM (no new users, no records, no AI) is a worse outcome than
 * briefly not enforcing a limit. The control plane re-writes the row on every plan change.
 */
export function parseEntitlements(value: string): Entitlements | null {
  try {
    const parsed = entitlementsSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
    console.error("core_entitlements: invalid plan row, enforcing no limits", parsed.error.issues);
  } catch (error) {
    console.error("core_entitlements: unparseable plan row, enforcing no limits", error);
  }
  return null;
}

/** The deployment's entitlements, or null when unmanaged (self-hosted). Cached 60 s per isolate. */
export async function loadEntitlements(
  db: Kysely<CoreDatabase>,
  options: { fresh?: boolean; now?: number } = {},
): Promise<Entitlements | null> {
  const now = options.now ?? Date.now();
  if (!options.fresh && cache && now - cache.at < ENTITLEMENTS_TTL_MS) return cache.value;
  const row = await db
    .selectFrom("core_entitlements")
    .select("value")
    .where("key", "=", ENTITLEMENTS_KEY)
    .executeTakeFirst();
  const value = row ? parseEntitlements(row.value) : null;
  cache = { value, at: now };
  return value;
}

/** People who count against `maxUsers`: active humans, never extension principals or support. */
export async function countActiveUsers(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_user")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .where("support_grant_id", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Live (not soft-deleted) people plus organisations. Each count is answered from the partial
 * `*_created_idx` indexes (WHERE deleted_at IS NULL), so it reads index entries, not rows.
 */
export async function countLiveRecords(db: Kysely<CoreDatabase>): Promise<number> {
  const [people, orgs] = await Promise.all([
    db
      .selectFrom("core_person")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("deleted_at", "is", null)
      .executeTakeFirst(),
    db
      .selectFrom("core_organisation")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("deleted_at", "is", null)
      .executeTakeFirst(),
  ]);
  return Number(people?.n ?? 0) + Number(orgs?.n ?? 0);
}

function label(e: Entitlements): string {
  return PLAN_LABELS[e.plan];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Throws PlanLimitError when adding `adding` users would pass `maxUsers`. */
export async function assertUserCapacity(db: Kysely<CoreDatabase>, adding = 1): Promise<void> {
  const e = await loadEntitlements(db);
  if (!e || e.maxUsers === null) return;
  const current = await countActiveUsers(db);
  // The first user always gets in: a deployment with nobody in it is no use to anyone.
  if (current === 0 || current + adding <= e.maxUsers) return;
  throw new PlanLimitError(
    `Your ${label(e)} plan allows ${plural(e.maxUsers, "user")}. Upgrade at ${BILLING_URL}`,
    { limit: "users", max: e.maxUsers, current, plan: e.plan, upgradeUrl: BILLING_URL },
  );
}

/** Throws PlanLimitError when adding `adding` people/organisations would pass `maxRecords`. */
export async function assertRecordCapacity(
  db: Kysely<CoreDatabase>,
  adding: number,
): Promise<void> {
  if (adding <= 0) return;
  const e = await loadEntitlements(db);
  if (!e || e.maxRecords === null) return;
  const current = await countLiveRecords(db);
  if (current + adding <= e.maxRecords) return;
  throw new PlanLimitError(
    `Your ${label(e)} plan allows ${plural(e.maxRecords, "record")} (people and organisations); ` +
      `this would make ${current + adding}. Upgrade at ${BILLING_URL}`,
    {
      limit: "records",
      max: e.maxRecords,
      current,
      adding,
      plan: e.plan,
      upgradeUrl: BILLING_URL,
    },
  );
}

/** May model calls use the platform's AI (Workers AI, Workers-secret keys)? True when unmanaged. */
export async function platformAiAllowed(db: Kysely<CoreDatabase>): Promise<boolean> {
  const e = await loadEntitlements(db);
  return e ? e.platformAi : true;
}
