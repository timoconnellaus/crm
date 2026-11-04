// GDPR erase (ADR 0019): hard-delete records now and redact the personal data the audit log holds
// about them through the sanctioned path (markers in core_audit_redactions; migration 0008).
import type { CoreDatabase } from "@crm/db";
import { type Kysely, type SqlBool, sql } from "kysely";
import type { HandlerContext } from "../operation.ts";
import { chunk } from "./common.ts";
import { findOwnedActivitiesAndTasks } from "./links.ts";

export interface EraseRequest {
  object: "person" | "organisation";
  /** The record the caller asked to erase; markers name it. */
  recordId: string;
  /** It plus any records merged into it (all hard-deleted). */
  recordIds: readonly string[];
  /**
   * Extra strings that identify the subject in audit content (emails, phone numbers), matched
   * case-insensitively. Short strings are ignored so that redaction stays targeted.
   */
  terms: readonly string[];
}

export interface EraseCounts {
  activities: number;
  tasks: number;
}

const MIN_TERM_LENGTH = 6;

/**
 * Queues the erase: redaction markers for every audit row and field-change row that mentions the
 * records, deletion of the activities and tasks they own, and the hard delete itself (child rows,
 * affiliations, tags, links and search rows go by cascade and trigger).
 */
export async function queueErase(ctx: HandlerContext, request: EraseRequest): Promise<EraseCounts> {
  const { object, recordId, recordIds } = request;
  const terms = [...new Set([...recordIds, ...request.terms].map((t) => t.trim().toLowerCase()))]
    .filter((t) => t.length >= MIN_TERM_LENGTH)
    .slice(0, 200);
  const termsJson = JSON.stringify(terms);
  const marker = {
    object_type: sql<string>`${object}`.as("object_type"),
    record_id: sql<string>`${recordId}`.as("record_id"),
    operation: sql<string>`${ctx.operation}`.as("operation"),
    user_id: sql<string>`${ctx.user.id}`.as("user_id"),
    at: sql<string>`${ctx.now}`.as("at"),
  };
  const columns = [
    "audit_id",
    "change_id",
    "object_type",
    "record_id",
    "operation",
    "user_id",
    "at",
  ] as const;

  // 1. Field-change rows about the records, or whose diff mentions them.
  ctx.write(
    ctx.db
      .insertInto("core_audit_redactions")
      .orIgnore()
      .columns(columns)
      .expression(
        ctx.db
          .selectFrom("core_audit_changes as c")
          .select([
            sql<string | null>`NULL`.as("audit_id"),
            "c.id as change_id",
            marker.object_type,
            marker.record_id,
            marker.operation,
            marker.user_id,
            marker.at,
          ])
          .where(
            sql<SqlBool>`(c.object_type = ${object} AND c.record_id IN (${sql.join(recordIds)}))
              OR EXISTS (SELECT 1 FROM json_each(${termsJson}) t
                WHERE instr(lower(c.diff), t.value) > 0)`,
          ),
      ),
  );
  // 2. Audit rows that own one of those change rows, or whose input/result/error mentions them.
  ctx.write(
    ctx.db
      .insertInto("core_audit_redactions")
      .orIgnore()
      .columns(columns)
      .expression(
        ctx.db
          .selectFrom("core_audit as a")
          .select([
            "a.id as audit_id",
            sql<number | null>`NULL`.as("change_id"),
            marker.object_type,
            marker.record_id,
            marker.operation,
            marker.user_id,
            marker.at,
          ])
          .where(
            sql<SqlBool>`a.id IN (SELECT c.audit_id FROM core_audit_changes c
                JOIN core_audit_redactions r ON r.change_id = c.id
                WHERE r.object_type = ${object} AND r.record_id = ${recordId})
              OR EXISTS (SELECT 1 FROM json_each(${termsJson}) t
                WHERE instr(lower(a.input), t.value) > 0
                  OR instr(lower(coalesce(a.result, '')), t.value) > 0
                  OR instr(lower(coalesce(a.error, '')), t.value) > 0)`,
          ),
      ),
  );

  // 3. Activities and tasks that are about only these records.
  const { activityIds, taskIds } = await findOwnedActivitiesAndTasks(ctx, object, recordIds);
  for (const ids of chunk(activityIds)) {
    ctx.write(ctx.db.deleteFrom("core_activity").where("id", "in", ids));
  }
  for (const ids of chunk(taskIds)) {
    ctx.write(ctx.db.deleteFrom("core_task").where("id", "in", ids));
  }

  // 4. The records. Merged-away records first: they point at the survivor.
  const ordered = [...recordIds.filter((id) => id !== recordId), recordId];
  for (const ids of chunk(ordered)) {
    ctx.write(
      object === "person"
        ? ctx.db.deleteFrom("core_person").where("id", "in", ids)
        : ctx.db.deleteFrom("core_organisation").where("id", "in", ids),
    );
  }
  return { activities: activityIds.length, tasks: taskIds.length };
}

/** A record plus every record merged into it, transitively (bounded). */
export async function withMergedRecords(
  ctx: HandlerContext,
  object: "person" | "organisation",
  id: string,
): Promise<string[]> {
  const ids = [id];
  let frontier = [id];
  while (frontier.length && ids.length < 40) {
    const rows =
      object === "person"
        ? await ctx.db
            .selectFrom("core_person")
            .select("id")
            .where("merged_into_id", "in", frontier)
            .execute()
        : await ctx.db
            .selectFrom("core_organisation")
            .select("id")
            .where("merged_into_id", "in", frontier)
            .execute();
    frontier = rows.map((r) => r.id).filter((r) => !ids.includes(r));
    ids.push(...frontier);
  }
  return ids.slice(0, 40);
}

/** How many audit and change rows an erase of the record redacted. */
export async function countRedactions(
  db: Kysely<CoreDatabase>,
  object: string,
  recordId: string,
): Promise<number> {
  const row = await db
    .selectFrom("core_audit_redactions")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("object_type", "=", object)
    .where("record_id", "=", recordId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
