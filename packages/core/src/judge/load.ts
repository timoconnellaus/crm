// Reading the judge's admin layer from D1 (core_settings `judge_settings`). Apart from the rest of
// the judge so that plain-Node eval runners can import `@relationship-os/core/judge` without the
// database's Worker types.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import {
  EMPTY_JUDGE_SETTINGS,
  JUDGE_SETTINGS,
  type JudgeSettings,
  parsePlacementLayer,
} from "./settings.ts";

/** The admin layer. A missing or unreadable row means no overrides. One primary-key read. */
export async function loadJudgeSettings(db: Kysely<CoreDatabase>): Promise<JudgeSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", JUDGE_SETTINGS)
    .executeTakeFirst();
  if (!row) return EMPTY_JUDGE_SETTINGS;
  try {
    const value = JSON.parse(row.value) as { placements?: unknown };
    return { placements: parsePlacementLayer(value.placements ?? {}) };
  } catch {
    return EMPTY_JUDGE_SETTINGS;
  }
}
