// Plans, limits and AI pricing (ADR 0211, ADR 0213). Decided in the landing-page interview:
//
//   Plan      Price       Users      Records (people + organisations)   AI included
//   Free      $0          1          1,000                              $0 (buy AI credit, or BYOK / MCP)
//   Team      $39/month   10         unlimited                          $10/month
//   Business  $149/month  unlimited  unlimited                          $25/month
//
// AI beyond the allowance is the provider's cost plus 20%, itemised in dollars (no opaque credits).
// Usage on the customer's own key (BYOK) or over MCP costs nothing.

export const PLAN_IDS = ["free", "team", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const SELF_SERVE_PLANS = ["free", "team", "business"] as const;
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in US cents (enterprise: by contract). */
  priceCents: number | null;
  maxUsers: number | null;
  maxRecords: number | null;
  /** AI included per calendar month, in micro-dollars of charged spend. */
  aiIncludedMicros: number;
  /** Paid plans get Stripe and a trial; Free has no subscription. */
  paid: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    maxUsers: 1,
    maxRecords: 1000,
    aiIncludedMicros: 0,
    paid: false,
  },
  team: {
    id: "team",
    name: "Team",
    priceCents: 3900,
    maxUsers: 10,
    maxRecords: null,
    aiIncludedMicros: 10_000_000,
    paid: true,
  },
  business: {
    id: "business",
    name: "Business",
    priceCents: 14900,
    maxUsers: null,
    maxRecords: null,
    aiIncludedMicros: 25_000_000,
    paid: true,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceCents: null,
    maxUsers: null,
    maxRecords: null,
    aiIncludedMicros: 25_000_000,
    paid: true,
  },
};

export function planOf(id: string): Plan {
  return PLANS[(PLAN_IDS as readonly string[]).includes(id) ? (id as PlanId) : "free"];
}

/**
 * The entitlement row the control plane writes into a customer's D1 (`core_entitlements`, key
 * `plan`, migration 0220). The deployment enforces it; self-hosted deployments have no row and
 * no limits.
 */
export interface Entitlements {
  plan: PlanId;
  maxUsers: number | null;
  maxRecords: number | null;
  /** False when a Free account's AI credit is used up: platform-paid models stop, BYOK works. */
  platformAi: boolean;
  updatedAt: string;
}

export function entitlementsFor(
  plan: PlanId,
  account: { ai_credit_micros: number },
  now: Date,
): Entitlements {
  const p = PLANS[plan];
  return {
    plan,
    maxUsers: p.maxUsers,
    maxRecords: p.maxRecords,
    platformAi: p.aiIncludedMicros > 0 || account.ai_credit_micros > 0,
    updatedAt: now.toISOString(),
  };
}

/** What a customer is charged for provider spend: cost plus the markup, in micro-dollars. */
export function chargedMicros(costMicros: number, markupPercent: number): number {
  return Math.round((costMicros * (100 + markupPercent)) / 100);
}

/**
 * Overage cents to report for one day, given month-to-date charged spend before and after it and
 * the cents already reported this month: whole cents of (spend beyond the allowance), less what
 * was reported, so rounding never loses or double-counts a cent.
 */
export function overageCents(input: {
  allowanceMicros: number;
  monthChargedAfterMicros: number;
  reportedCents: number;
}): number {
  const beyond = Math.max(0, input.monthChargedAfterMicros - input.allowanceMicros);
  return Math.max(0, Math.floor(beyond / 10_000) - input.reportedCents);
}

/** AI credit packs a Free customer can buy, in cents. */
export const CREDIT_PACKS_CENTS = [1000, 2500, 5000] as const;

const RESERVED = new Set([
  "app",
  "www",
  "api",
  "admin",
  "mail",
  "email",
  "status",
  "docs",
  "help",
  "support",
  "billing",
  "dispatch",
  "control",
  "staging",
  "static",
  "assets",
  "cdn",
  "blog",
  "login",
  "auth",
  "relationship-os",
  "ros",
]);

/** A workspace subdomain: 3–32 of a-z, 0-9 and inner hyphens, not reserved. */
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug)) {
    return "Use 3–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.";
  }
  if (slug.includes("--")) return "Use single hyphens only.";
  if (RESERVED.has(slug)) return "That name is reserved.";
  return null;
}
