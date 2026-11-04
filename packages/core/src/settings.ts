// Org settings (core_settings), starting with the approval policy.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import {
  APPROVAL_POLICY_SETTING,
  type ApprovalPolicy,
  approvalPolicySchema,
  DEFAULT_POLICY,
} from "./gate.ts";

/**
 * The org's approval policy. A missing or unreadable setting falls back to Cautious, never to
 * something looser: a broken policy must not open the gate.
 */
export async function loadApprovalPolicy(db: Kysely<CoreDatabase>): Promise<ApprovalPolicy> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", APPROVAL_POLICY_SETTING)
    .executeTakeFirst();
  if (!row) return { preset: "cautious" };
  try {
    const parsed = approvalPolicySchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : { preset: "cautious" };
  } catch {
    return { preset: "cautious" };
  }
}

export { DEFAULT_POLICY };

/** The base currency (migration 0100, ADR 0101): ISO 4217, JSON string. */
export const BASE_CURRENCY_SETTING = "base_currency";

/** The org's general settings. A missing or unreadable base currency falls back to USD. */
export async function loadGeneralSettings(
  db: Kysely<CoreDatabase>,
): Promise<{ baseCurrency: string }> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", BASE_CURRENCY_SETTING)
    .executeTakeFirst();
  try {
    const value = row ? (JSON.parse(row.value) as unknown) : null;
    return { baseCurrency: typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "USD" };
  } catch {
    return { baseCurrency: "USD" };
  }
}
