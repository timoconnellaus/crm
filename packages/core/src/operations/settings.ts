// settings.* operations: the org's general settings (Settings → General). For now the base
// currency (ADR 0101): every currency field without its own currency displays in it. Multi-currency
// and FX are out of scope; changing it relabels amounts, it never converts them.
import { z } from "zod";
import { defineOperation } from "../operation.ts";

export { COMMON_CURRENCIES } from "../currencies.ts";

import { BASE_CURRENCY_SETTING, loadGeneralSettings } from "../settings.ts";

const generalSettings = z.object({
  baseCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe("ISO 4217 code of the deployment's one currency, e.g. USD, EUR, AUD"),
});

export const settingsGet = defineOperation({
  name: "settings.get",
  description:
    "Get the org's general settings: the base currency every currency field (deal values, " +
    "budgets) is shown in. Read-only.",
  input: z.object({}),
  output: generalSettings,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return loadGeneralSettings(ctx.db);
  },
});

export const settingsUpdate = defineOperation({
  name: "settings.update",
  description:
    "Change the org's general settings (admins). baseCurrency is the ISO 4217 code currency " +
    "fields display in; changing it relabels amounts and does not convert them.",
  input: generalSettings.partial(),
  output: generalSettings,
  permission: "settings:manage",
  risk: "write",
  async handler(input, ctx) {
    const before = await loadGeneralSettings(ctx.db);
    const after = { ...before, ...input };
    if (input.baseCurrency !== undefined) {
      const value = JSON.stringify(input.baseCurrency);
      ctx.write(
        ctx.db
          .insertInto("core_settings")
          .values({
            key: BASE_CURRENCY_SETTING,
            value,
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
          ),
      );
    }
    ctx.recordChange({ object: "settings", id: "general", action: "update", before, after });
    return after;
  },
});

export const settingsOperations = [settingsGet, settingsUpdate] as const;
