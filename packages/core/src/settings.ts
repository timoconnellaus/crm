// Org settings (core_settings), starting with the approval policy.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import type { AiAdminSettings } from "./ai/client.ts";
import { PROVIDERS, type ProviderId, parseRoleLayer } from "./ai/roles.ts";
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

/** Stage 8 (ADR 0167): the organisation's name, logo and timezone, set by the wizard. */
export const ORG_NAME_SETTING = "org_name";
export const ORG_LOGO_SETTING = "org_logo";
export const ORG_TIMEZONE_SETTING = "org_timezone";
/** Stage 7b (ADR 0200): the in-app assistant's display name. Never "Claude"; default "Assistant". */
export const ASSISTANT_NAME_SETTING = "assistant_name";
export const DEFAULT_ASSISTANT_NAME = "Assistant";

export interface GeneralSettings {
  baseCurrency: string;
  orgName: string | null;
  /** A small image as a data: URL, or null. */
  logo: string | null;
  /** IANA timezone, e.g. Europe/London. */
  timezone: string;
  /** The in-app assistant's display name (ADR 0200). */
  assistantName: string;
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The org's general settings. A missing or unreadable base currency falls back to USD, a missing
 * timezone to UTC. (A stored `ai_mode` row from before ADR 0167's amendment is ignored: which
 * models run is the model registry's, Settings → AI.)
 */
export async function loadGeneralSettings(db: Kysely<CoreDatabase>): Promise<GeneralSettings> {
  const rows = await db
    .selectFrom("core_settings")
    .select(["key", "value"])
    .where("key", "in", [
      BASE_CURRENCY_SETTING,
      ORG_NAME_SETTING,
      ORG_LOGO_SETTING,
      ORG_TIMEZONE_SETTING,
      ASSISTANT_NAME_SETTING,
    ])
    .execute();
  const get = (key: string) => parseJson(rows.find((r) => r.key === key)?.value);
  const currency = get(BASE_CURRENCY_SETTING);
  const name = get(ORG_NAME_SETTING);
  const logo = get(ORG_LOGO_SETTING);
  const timezone = get(ORG_TIMEZONE_SETTING);
  const assistantName = get(ASSISTANT_NAME_SETTING);
  return {
    baseCurrency: typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    orgName: typeof name === "string" && name.trim() ? name : null,
    logo: typeof logo === "string" && logo.startsWith("data:image/") ? logo : null,
    timezone: typeof timezone === "string" && isTimezone(timezone) ? timezone : "UTC",
    assistantName:
      typeof assistantName === "string" && assistantName.trim()
        ? assistantName.trim()
        : DEFAULT_ASSISTANT_NAME,
  };
}

/** Settings → AI (ADR 0150): role overrides and BYOK flags. Settings only, never keys. */
export const AI_SETTINGS = "ai_settings";

/** The admin layer of the model registry. A missing or unreadable setting means no overrides. */
export async function loadAiSettings(db: Kysely<CoreDatabase>): Promise<AiAdminSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", AI_SETTINGS)
    .executeTakeFirst();
  if (!row) return { roles: {}, byok: [] };
  try {
    const value = JSON.parse(row.value) as { roles?: unknown; byok?: unknown };
    return {
      roles: parseRoleLayer(JSON.stringify(value.roles ?? {})),
      byok: Array.isArray(value.byok)
        ? (value.byok.filter((p) => (PROVIDERS as readonly unknown[]).includes(p)) as ProviderId[])
        : [],
    };
  } catch {
    return { roles: {}, byok: [] };
  }
}
