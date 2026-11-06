// core_duplicate_pair writes (stage 16, ADR 0247). One row per pair (a_id < b_id). The scan
// upserts open pairs and never reopens a dismissed or merged one; a merge closes its pair and
// drops the merged record's other open pairs (the survivor is scanned again, since it changed).
import { sql } from "kysely";
import type { HandlerContext } from "../operation.ts";
import { chunk } from "../records/common.ts";
import type { DuplicateObject, DuplicateRule, PairDetails } from "./rules.ts";
import { pairKey } from "./rules.ts";

export interface FoundPair {
  aId: string;
  bId: string;
  rules: DuplicateRule[];
  details: PairDetails;
}

type Writer = Pick<HandlerContext, "db" | "write" | "now">;

/** A merge closes the survivor–duplicate pair and removes the duplicate's other open pairs. */
export function queueClosePairs(
  ctx: Writer & Pick<HandlerContext, "user">,
  object: DuplicateObject,
  survivorId: string,
  mergedId: string,
): void {
  const [a, b] = pairKey(survivorId, mergedId);
  ctx.write(
    ctx.db
      .updateTable("core_duplicate_pair")
      .set({ status: "merged", decided_at: ctx.now, decided_by: ctx.user.id, updated_at: ctx.now })
      .where("object", "=", object)
      .where("a_id", "=", a)
      .where("b_id", "=", b)
      .where("status", "=", "open"),
    ctx.db
      .deleteFrom("core_duplicate_pair")
      .where("object", "=", object)
      .where("status", "=", "open")
      .where((eb) => eb.or([eb("a_id", "=", mergedId), eb("b_id", "=", mergedId)])),
  );
}

/**
 * Upserts open pairs (rules and details refreshed, updated_at set to now). A pair already
 * dismissed or merged is left alone, so "Not duplicates" is never suggested again.
 */
export function queueUpsertPairs(ctx: Writer, object: DuplicateObject, pairs: FoundPair[]): void {
  for (const part of chunk(pairs, 200)) {
    const rows = part.map((p) => ({
      a: p.aId,
      b: p.bId,
      r: JSON.stringify(p.rules),
      d: JSON.stringify(p.details),
    }));
    ctx.write(
      sql`INSERT INTO core_duplicate_pair (object, a_id, b_id, rules, details, status, created_at, updated_at)
        SELECT ${object}, json_extract(value, '$.a'), json_extract(value, '$.b'),
               json_extract(value, '$.r'), json_extract(value, '$.d'), 'open', ${ctx.now}, ${ctx.now}
        FROM json_each(${JSON.stringify(rows)}) WHERE true
        ON CONFLICT (object, a_id, b_id) DO UPDATE SET
          rules = excluded.rules, details = excluded.details, updated_at = excluded.updated_at
        WHERE core_duplicate_pair.status = 'open'`.compile(ctx.db),
    );
  }
}

/** Removes open pairs involving `ids` that this run did not find again (updated before now). */
export function queueDropStalePairs(ctx: Writer, object: DuplicateObject, ids: string[]): void {
  for (const part of chunk(ids, 200)) {
    const list = JSON.stringify(part);
    ctx.write(
      ctx.db
        .deleteFrom("core_duplicate_pair")
        .where("object", "=", object)
        .where("status", "=", "open")
        .where("updated_at", "<", ctx.now)
        .where((eb) =>
          eb.or([
            eb("a_id", "in", sql<string>`(SELECT value FROM json_each(${list}))`),
            eb("b_id", "in", sql<string>`(SELECT value FROM json_each(${list}))`),
          ]),
        ),
    );
  }
}
