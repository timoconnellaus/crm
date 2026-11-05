// settings.* operations: the org's general settings (Settings → General and the setup wizard):
// the base currency (ADR 0101: every currency field without its own currency displays in it;
// changing it relabels amounts, it never converts them), and since stage 8 the organisation's
// name, logo and timezone and the AI mode (ADR 0167).
import { z } from "zod";
import { defineOperation } from "../operation.ts";

export { COMMON_CURRENCIES } from "../currencies.ts";

import {
  AI_MODE_SETTING,
  AI_MODES,
  BASE_CURRENCY_SETTING,
  type GeneralSettings,
  isTimezone,
  loadGeneralSettings,
  ORG_LOGO_SETTING,
  ORG_NAME_SETTING,
  ORG_TIMEZONE_SETTING,
} from "../settings.ts";

/** Logos are stored inline (a data: URL), so keep them small. */
export const MAX_LOGO_LENGTH = 200_000;

const generalSettings = z.object({
  baseCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe("ISO 4217 code of the deployment's one currency, e.g. USD, EUR, AUD"),
  orgName: z.string().trim().max(120).nullable().describe("The organisation's name"),
  logo: z
    .string()
    .max(MAX_LOGO_LENGTH)
    .regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .describe("A small logo image as a data: URL (PNG, JPEG, GIF, WebP or SVG), or null"),
  timezone: z
    .string()
    .max(64)
    .refine(isTimezone, "Unknown IANA timezone")
    .describe("IANA timezone the organisation works in, e.g. Europe/London"),
  aiMode: z
    .enum(AI_MODES)
    .describe("workers-ai: every model role uses Workers AI in this account (no third-party keys)"),
});

export const settingsGet = defineOperation({
  name: "settings.get",
  description:
    "Get the org's general settings: the base currency every currency field (deal values, " +
    "budgets) is shown in, the organisation's name, logo and timezone, and the AI mode. Read-only.",
  input: z.object({}),
  output: generalSettings,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return loadGeneralSettings(ctx.db);
  },
});

const SETTING_KEYS: Record<keyof GeneralSettings, string> = {
  baseCurrency: BASE_CURRENCY_SETTING,
  orgName: ORG_NAME_SETTING,
  logo: ORG_LOGO_SETTING,
  timezone: ORG_TIMEZONE_SETTING,
  aiMode: AI_MODE_SETTING,
};

export const settingsUpdate = defineOperation({
  name: "settings.update",
  description:
    "Change the org's general settings (admins). baseCurrency is the ISO 4217 code currency " +
    "fields display in; changing it relabels amounts and does not convert them. orgName, logo " +
    "(a data: URL) and timezone describe the organisation; aiMode chooses the AI provider.",
  input: generalSettings.partial(),
  output: generalSettings,
  permission: "settings:manage",
  risk: "write",
  async handler(input, ctx) {
    const before = await loadGeneralSettings(ctx.db);
    const after: Record<string, unknown> = { ...before };
    for (const key of Object.keys(SETTING_KEYS) as (keyof GeneralSettings)[]) {
      const raw = input[key];
      if (raw === undefined) continue;
      const normalised = key === "orgName" && typeof raw === "string" && !raw.trim() ? null : raw;
      after[key] = normalised;
      const value = JSON.stringify(normalised);
      ctx.write(
        ctx.db
          .insertInto("core_settings")
          .values({ key: SETTING_KEYS[key], value, updated_at: ctx.now, updated_by: ctx.user.id })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
          ),
      );
    }
    // A logo is long and says nothing in a diff.
    const audit = (s: Record<string, unknown>) => ({
      ...s,
      logo: typeof s.logo === "string" ? `(image, ${s.logo.length} characters)` : null,
    });
    ctx.recordChange({
      object: "settings",
      id: "general",
      action: "update",
      before: audit({ ...before }),
      after: audit(after),
    });
    return after as unknown as GeneralSettings;
  },
});

export const settingsOperations = [settingsGet, settingsUpdate] as const;
