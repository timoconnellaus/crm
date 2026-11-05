// The judge's own spend count (ADR 0234): calls and input tokens per day and placement in
// core_judge_usage (migration 0252), shown per placement in Settings → AI. Counting never costs a
// write of its own: a placement adds `judgeUsageStatement` to the batch it already writes (the
// adjudicator's verdict batch, the extension proposal's batch). A call whose result is not stored
// (extension.check, the Test button) is in the Workers log line only, not counted here.
//
// Apart from the rest of the judge so that plain-Node eval runners can import
// `@relationship-os/core/judge` without the database's types.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { jevCost } from "./jev.ts";
import type { JudgePlacementId } from "./placements.ts";

/** The upsert that counts `calls` judge calls of `placement` today, for a batch already written. */
export function judgeUsageStatement(
  db: Kysely<CoreDatabase>,
  placement: JudgePlacementId,
  usage: { calls: number; inputTokens: number },
  now: Date | string,
) {
  const day = (typeof now === "string" ? now : now.toISOString()).slice(0, 10);
  const calls = Math.max(0, Math.round(usage.calls) || 0);
  const tokens = Math.max(0, Math.round(usage.inputTokens) || 0);
  return db
    .insertInto("core_judge_usage")
    .values({ day, placement, calls, input_tokens: tokens })
    .onConflict((oc) =>
      oc.columns(["day", "placement"]).doUpdateSet((eb) => ({
        calls: eb("core_judge_usage.calls", "+", calls),
        input_tokens: eb("core_judge_usage.input_tokens", "+", tokens),
      })),
    );
}

export interface PlacementSpend {
  placement: string;
  calls: number;
  inputTokens: number;
  /** USD at JEV_PRICE (input tokens only). */
  costUsd: number;
}

/** Spend per placement over the last `days` days (today included), most expensive first. */
export async function judgeSpend(
  db: Kysely<CoreDatabase>,
  days: number,
  now: Date | string,
): Promise<PlacementSpend[]> {
  const at = typeof now === "string" ? new Date(now) : now;
  const since = new Date(at.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .selectFrom("core_judge_usage")
    .select(["placement"])
    .select((eb) => [
      eb.fn.sum<number>("calls").as("calls"),
      eb.fn.sum<number>("input_tokens").as("input_tokens"),
    ])
    .where("day", ">=", since)
    .groupBy("placement")
    .execute();
  return rows
    .map((r) => ({
      placement: r.placement,
      calls: Number(r.calls) || 0,
      inputTokens: Number(r.input_tokens) || 0,
      costUsd: jevCost(Number(r.input_tokens) || 0),
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens || b.calls - a.calls);
}
